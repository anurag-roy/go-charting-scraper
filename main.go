// Command go-charting-scraper scrapes historical market data and renders it as
// a chart, either to a PNG file (--once) or via an HTTP dashboard.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/anurag-roy/go-charting-scraper/internal/chart"
	"github.com/anurag-roy/go-charting-scraper/internal/scraper"
	"github.com/anurag-roy/go-charting-scraper/internal/server"
)

func main() {
	var (
		addr     = flag.String("addr", ":8080", "HTTP listen address for the dashboard")
		coin     = flag.String("coin", "bitcoin", "coin id to scrape (e.g. bitcoin, ethereum)")
		currency = flag.String("currency", "usd", "fiat currency to price against")
		days     = flag.Int("days", 30, "number of days of history to scrape")
		once     = flag.Bool("once", false, "scrape once, write a PNG, and exit")
		out      = flag.String("out", "chart.png", "output file path when using --once")
	)
	flag.Parse()

	client := scraper.New()

	if *once {
		if err := renderOnce(client, *coin, *currency, *days, *out); err != nil {
			log.Fatalf("error: %v", err)
		}
		return
	}

	srv := server.New(client, server.Config{
		Coin:     *coin,
		Currency: *currency,
		Days:     *days,
	})
	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("go-charting-scraper listening on %s (coin=%s currency=%s days=%d)", *addr, *coin, *currency, *days)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

func renderOnce(client *scraper.Client, coin, currency string, days int, out string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	series, err := client.FetchMarketChart(ctx, coin, currency, days)
	if err != nil {
		return err
	}
	png, err := chart.RenderLineChart(series)
	if err != nil {
		return err
	}
	if err := os.WriteFile(out, png, 0o644); err != nil {
		return err
	}

	last, _ := series.Last()
	log.Printf("scraped %d points for %s/%s; latest %.2f %s; wrote %s (%d bytes)",
		len(series.Points), coin, currency, last.Price, currency, out, len(png))
	return nil
}
