# go-charting-scraper

A small Go application that **scrapes** historical market price data from the
public [CoinGecko API](https://www.coingecko.com/en/api) and **charts** it as a
PNG line chart — either written to disk or served from a live HTTP dashboard.

## Requirements

- Go 1.22+

No CGO or system libraries are required; charts are rendered with the pure-Go
[`wcharczuk/go-chart`](https://github.com/wcharczuk/go-chart) library.

## Getting started

```bash
# Fetch dependencies
go mod download

# Run the tests
go test ./...

# Build the binary
go build -o bin/scraper .
```

## Usage

### Dashboard (default)

Start the HTTP server and open the dashboard in a browser:

```bash
go run . --addr :8080
# then visit http://localhost:8080
```

The dashboard scrapes the configured coin/currency and renders a live chart at
`/chart.png`. A `/healthz` endpoint is available for readiness checks.

### One-shot PNG

Scrape once and write a PNG file, then exit:

```bash
go run . --once --coin bitcoin --currency usd --days 30 --out chart.png
```

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--addr` | `:8080` | HTTP listen address for the dashboard |
| `--coin` | `bitcoin` | Coin id to scrape (e.g. `bitcoin`, `ethereum`) |
| `--currency` | `usd` | Fiat currency to price against |
| `--days` | `30` | Number of days of history to scrape |
| `--once` | `false` | Scrape once, write a PNG, and exit |
| `--out` | `chart.png` | Output file path when using `--once` |

## Project layout

```
main.go                     # CLI entrypoint (server + --once modes)
internal/scraper            # CoinGecko market-chart scraper
internal/chart              # PNG line-chart rendering
internal/server             # HTTP dashboard with a short-lived chart cache
.cursor/environment.json    # Cloud Agent dev environment definition
```

## Cloud Agent environment

`.cursor/environment.json` provisions the environment for Cursor Cloud Agents:

- `install` — downloads modules and builds the binary.
- `terminals` — runs the dashboard on port `8080` so its logs stay visible.
- `ports` — exposes port `8080`.
