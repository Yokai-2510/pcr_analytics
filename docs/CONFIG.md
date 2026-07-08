# Trade Configuration

There is **one active trade config**, stored as a JSON blob in the
`trade_configs` table (`active = 1`). The API reads/writes it via
`/api/trade/config`; the engine reads it fresh every tick. Defaults live in
`DEFAULT_CONFIG` (`trade/persistence.py`) and any missing key is back-filled, so
a saved config is always complete.

## Global keys

| key                     | default    | meaning |
|-------------------------|------------|---------|
| `mode`                  | `paper`    | `paper` (simulated) or `live` (real orders). |
| `auto_execute`          | `false`    | When off, signals are logged but no order fires. |
| `signal_mode`           | `oi_only`  | Which sources trade (see below). |
| `instruments`           | `["nifty"]`| Which indices to trade. |
| `max_positions_per_day` | `3`        | Session-wide cap on new positions. |

### Live order keys (used only when `mode = live`)

| key                          | default  | meaning |
|------------------------------|----------|---------|
| `order_type`                 | `MARKET` | `MARKET` or `LIMIT` (LIMIT prices at the signal LTP). |
| `order_product`              | `I`      | `I` intraday / `D` delivery. |
| `order_validity`             | `DAY`    | `DAY` or `IOC`. |
| `fill_timeout_seconds`       | `8`      | Cancel an order not filled by then. |
| `fill_poll_interval_seconds` | `0.3`    | Fill-status poll cadence. |

### `signal_mode` values

`oi_only` · `volume_only` · `vwap_only` · `both` (legacy = oi+volume) ·
comma lists like `oi,volume,vwap`. Each listed source runs independently.

## Per-strategy blocks

`config["strategies"]` holds one **full, independent** block per source —
`oi`, `volume`, `vwap`, `ltp`, `optvol` — so each strategy has its own strike
selection, sizing, and exit rules. A block overrides the legacy top-level keys
for that source only. Each block:

| key                       | default | meaning |
|---------------------------|---------|---------|
| `strike_mode`             | `atm`   | `atm` / `itm_1` / `itm_2` / `custom_steps`. |
| `custom_steps`            | `0`     | strikes from ATM when `strike_mode=custom_steps` (+ITM / −OTM, side-aware). |
| `lots`                    | `1`     | lots per trade (× lot size = qty). |
| `cooldown_minutes`        | `0`     | min gap between entries on this source+instrument. |
| `no_entry_after`          | `15:25` | stop opening new positions after this time. |
| `exit_on_counter_crossover` | `true`| close on the opposite signal of this source. |
| `stop_loss_enabled` / `stop_loss_pct` | `true` / `30` | hard stop below entry. |
| `target_enabled` / `target_pct`       | `true` / `50` | take-profit above entry. |
| `trailing_sl_enabled` / `_trigger_pct` / `_step_pct` | `false` / `20` / `10` | ratcheting stop once in profit. |
| `peak_trail_enabled` / `peak_trail_pct` | `false` / `80` | give back at most (100−pct)% of the peak. |
| `time_exit_enabled` / `time_exit_at`  | `true` / `15:15` | force close at this time. |

## Where it's edited

Frontend **Trade → Configs**: a Global tab (mode, auto-execute, instruments,
max positions) plus one tab per strategy with its own entry + full exit
conditions. Saving writes the whole blob back via `/api/trade/config`.
