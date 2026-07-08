"""Broker abstraction for the trade engine.

A Broker has exactly two responsibilities — placing an entry order and
placing an exit order — and a single source of truth for the price each
fills at. PaperBroker simulates fills against the latest oi_snapshots
LTP. LiveBroker will land here later wrapping upstox.orders; the engine
will not need to change.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import broker_api
import utilities as utils

from trade import persistence, strikes

logger = logging.getLogger(__name__)

# Upstox order states that end the fill poll.
_FILLED_STATES = {"complete", "completed", "filled"}
_DEAD_STATES = {"rejected", "cancelled", "canceled"}

OptionType = Literal["CE", "PE"]


@dataclass(frozen=True)
class OrderResult:
    """The outcome of a single broker.place_* call."""

    success: bool
    client_order_ref: str
    broker_order_id: str | None
    price: float | None
    error: str | None = None


class Broker(Protocol):
    """Two-method protocol the engine talks to. Live broker will implement
    the same shape."""

    mode: str

    def place_entry(
        self,
        *,
        instrument: str,
        instrument_token: str,
        strike: float,
        option_type: OptionType,
        qty: int,
        lots: int,
        signal_timestamp: str,
        ref_price: float,
    ) -> OrderResult: ...

    def place_exit(
        self,
        *,
        position: dict[str, Any],
        intent: str,
        ref_price: float,
    ) -> OrderResult: ...


# ── Paper broker ───────────────────────────────────────────────────────


class PaperBroker:
    """Atomic fill at the supplied reference LTP. The engine reads LTP
    from the latest oi_snapshots row before calling us; we trust it.
    No external IO."""

    mode = "paper"

    def place_entry(
        self,
        *,
        instrument: str,
        instrument_token: str,
        strike: float,
        option_type: OptionType,
        qty: int,
        lots: int,
        signal_timestamp: str,
        ref_price: float,
    ) -> OrderResult:
        if ref_price is None or ref_price <= 0:
            return OrderResult(
                success=False, client_order_ref="", broker_order_id=None,
                price=None, error="invalid ref_price",
            )
        ref = uuid.uuid4().hex
        logger.info(
            "PaperBroker.place_entry: %s %s @ %s qty=%s ref=%s",
            instrument, option_type, ref_price, qty, ref,
        )
        return OrderResult(
            success=True, client_order_ref=ref, broker_order_id=None,
            price=float(ref_price), error=None,
        )

    def place_exit(
        self,
        *,
        position: dict[str, Any],
        intent: str,
        ref_price: float,
    ) -> OrderResult:
        if ref_price is None or ref_price <= 0:
            return OrderResult(
                success=False, client_order_ref="", broker_order_id=None,
                price=None, error="invalid ref_price",
            )
        ref = uuid.uuid4().hex
        logger.info(
            "PaperBroker.place_exit: pos=%s intent=%s @ %s qty=%s ref=%s",
            position.get("id"), intent, ref_price, position.get("qty"), ref,
        )
        return OrderResult(
            success=True, client_order_ref=ref, broker_order_id=None,
            price=float(ref_price), error=None,
        )


# ── Live broker ────────────────────────────────────────────────────────


class LiveBroker:
    """Places real Upstox orders and BLOCKS until each is fill-confirmed, so the
    engine keeps its synchronous "OrderResult == filled" contract. A placement
    that is rejected, cancelled, or never fills within the timeout returns
    success=False (and the poll-timeout case cancels the still-open order), so a
    failed order can never be recorded as an open position.

    Order parameters (product / order_type / validity / fill timeout) come from
    the active trade config; sensible intraday-market defaults otherwise."""

    mode = "live"

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._product = str(cfg.get("order_product") or "I")           # I=intraday
        self._order_type = str(cfg.get("order_type") or "MARKET").upper()
        self._validity = str(cfg.get("order_validity") or "DAY").upper()
        self._fill_timeout_s = float(cfg.get("fill_timeout_seconds") or 8.0)
        self._poll_interval_s = float(cfg.get("fill_poll_interval_seconds") or 0.3)

    # -- internal: place then poll to a terminal state ------------------
    def _place_and_confirm(
        self, *, instrument_token: str, qty: int, transaction_type: str,
        ref_price: float, label: str,
    ) -> OrderResult:
        client_ref = uuid.uuid4().hex
        # MARKET orders send price 0; a LIMIT order uses the reference LTP.
        limit_price = float(ref_price) if self._order_type == "LIMIT" else 0.0
        try:
            order_id = broker_api.place_order(
                instrument_token=instrument_token,
                quantity=int(qty),
                transaction_type=transaction_type,
                order_type=self._order_type,
                product=self._product,
                price=limit_price,
                validity=self._validity,
                tag=client_ref,
            )
        except Exception as exc:
            logger.error("LiveBroker %s placement failed: %s", label, exc)
            return OrderResult(
                success=False, client_order_ref=client_ref, broker_order_id=None,
                price=None, error=f"placement failed: {exc}",
            )

        logger.info("LiveBroker %s placed order_id=%s ref=%s; awaiting fill", label, order_id, client_ref)
        deadline = time.monotonic() + self._fill_timeout_s
        last_status = "unknown"
        while time.monotonic() < deadline:
            try:
                details = broker_api.get_order_details(order_id)
            except Exception as exc:
                logger.warning("LiveBroker %s poll error (order %s): %s", label, order_id, exc)
                time.sleep(self._poll_interval_s)
                continue
            last_status = str(details.get("status") or "").lower()
            if last_status in _FILLED_STATES:
                avg = details.get("average_price")
                fill_price = float(avg) if avg else float(ref_price)
                logger.info("LiveBroker %s FILLED order_id=%s @ %s", label, order_id, fill_price)
                return OrderResult(
                    success=True, client_order_ref=client_ref,
                    broker_order_id=str(order_id), price=fill_price, error=None,
                )
            if last_status in _DEAD_STATES:
                msg = details.get("status_message") or details.get("status")
                logger.error("LiveBroker %s order_id=%s %s: %s", label, order_id, last_status, msg)
                return OrderResult(
                    success=False, client_order_ref=client_ref,
                    broker_order_id=str(order_id), price=None,
                    error=f"{last_status}: {msg}",
                )
            time.sleep(self._poll_interval_s)

        # Timed out still open — cancel so it can't fill after we've given up.
        logger.error("LiveBroker %s order_id=%s fill timeout (last=%s); cancelling",
                     label, order_id, last_status)
        broker_api.cancel_order(order_id)
        return OrderResult(
            success=False, client_order_ref=client_ref, broker_order_id=str(order_id),
            price=None, error=f"fill timeout after {self._fill_timeout_s:.0f}s (last={last_status})",
        )

    def place_entry(
        self, *, instrument: str, instrument_token: str, strike: float,
        option_type: OptionType, qty: int, lots: int, signal_timestamp: str,
        ref_price: float,
    ) -> OrderResult:
        if ref_price is None or ref_price <= 0:
            return OrderResult(False, "", None, None, error="invalid ref_price")
        return self._place_and_confirm(
            instrument_token=instrument_token, qty=qty, transaction_type="BUY",
            ref_price=ref_price, label=f"entry[{instrument} {option_type} {strike}]",
        )

    def place_exit(
        self, *, position: dict[str, Any], intent: str, ref_price: float,
    ) -> OrderResult:
        token = position.get("instrument_token")
        qty = position.get("qty")
        if not token or not qty:
            return OrderResult(False, "", None, None, error="position missing token/qty")
        return self._place_and_confirm(
            instrument_token=str(token), qty=int(qty), transaction_type="SELL",
            ref_price=float(ref_price or 0.0),
            label=f"exit[pos={position.get('id')} {intent}]",
        )


# ── Dispatch ───────────────────────────────────────────────────────────


_PAPER = PaperBroker()


def get_broker(mode: str, config: dict[str, Any] | None = None) -> Broker:
    """Return the broker for the requested mode. Live mode places real orders
    via LiveBroker; anything else is paper."""
    if str(mode).lower() == "live":
        logger.info("LiveBroker active — real orders will be placed")
        return LiveBroker(config)
    return _PAPER
