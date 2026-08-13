// Package server exposes the scraped charts over HTTP.
package server

import (
	"context"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/anurag-roy/go-charting-scraper/internal/chart"
	"github.com/anurag-roy/go-charting-scraper/internal/scraper"
)

// Fetcher abstracts the scraper so the server can be tested with a fake.
type Fetcher interface {
	FetchMarketChart(ctx context.Context, coin, currency string, days int) (*scraper.Series, error)
}

// Config controls the default chart the server renders.
type Config struct {
	Coin     string
	Currency string
	Days     int
	CacheTTL time.Duration
}

func (c Config) withDefaults() Config {
	if c.Coin == "" {
		c.Coin = "bitcoin"
	}
	if c.Currency == "" {
		c.Currency = "usd"
	}
	if c.Days <= 0 {
		c.Days = 30
	}
	if c.CacheTTL <= 0 {
		c.CacheTTL = 60 * time.Second
	}
	return c
}

// Server serves an HTML dashboard and the rendered PNG chart.
type Server struct {
	cfg     Config
	fetcher Fetcher

	mu       sync.Mutex
	cachePNG []byte
	cacheAt  time.Time
	lastInfo string
}

// New builds a Server from a fetcher and config.
func New(fetcher Fetcher, cfg Config) *Server {
	return &Server{cfg: cfg.withDefaults(), fetcher: fetcher}
}

// Handler returns the HTTP routes for the server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/chart.png", s.handleChart)
	mux.HandleFunc("/healthz", s.handleHealth)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	data := struct {
		Coin     string
		Currency string
		Days     int
	}{s.cfg.Coin, s.cfg.Currency, s.cfg.Days}
	if err := indexTmpl.Execute(w, data); err != nil {
		log.Printf("server: render index: %v", err)
	}
}

func (s *Server) handleChart(w http.ResponseWriter, r *http.Request) {
	coin := valueOr(r.URL.Query().Get("coin"), s.cfg.Coin)
	currency := valueOr(r.URL.Query().Get("currency"), s.cfg.Currency)
	days := s.cfg.Days
	if d := r.URL.Query().Get("days"); d != "" {
		if parsed, err := strconv.Atoi(d); err == nil && parsed > 0 {
			days = parsed
		}
	}

	png, err := s.chartPNG(r.Context(), coin, currency, days)
	if err != nil {
		log.Printf("server: chart error: %v", err)
		http.Error(w, "failed to build chart: "+err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	if _, err := w.Write(png); err != nil {
		log.Printf("server: write png: %v", err)
	}
}

// chartPNG returns a rendered chart, using a short-lived cache for the default
// asset to avoid hammering the upstream API on rapid refreshes.
func (s *Server) chartPNG(ctx context.Context, coin, currency string, days int) ([]byte, error) {
	isDefault := coin == s.cfg.Coin && currency == s.cfg.Currency && days == s.cfg.Days

	if isDefault {
		s.mu.Lock()
		if s.cachePNG != nil && time.Since(s.cacheAt) < s.cfg.CacheTTL {
			png := s.cachePNG
			s.mu.Unlock()
			return png, nil
		}
		s.mu.Unlock()
	}

	series, err := s.fetcher.FetchMarketChart(ctx, coin, currency, days)
	if err != nil {
		return nil, err
	}
	png, err := chart.RenderLineChart(series)
	if err != nil {
		return nil, err
	}

	if isDefault {
		s.mu.Lock()
		s.cachePNG = png
		s.cacheAt = time.Now()
		if last, ok := series.Last(); ok {
			s.lastInfo = fmt.Sprintf("%s=%.2f %s", coin, last.Price, currency)
		}
		s.mu.Unlock()
	}
	return png, nil
}

func valueOr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

var indexTmpl = template.Must(template.New("index").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>go-charting-scraper</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  header { padding: 24px 32px; border-bottom: 1px solid #1e293b; }
  h1 { margin: 0; font-size: 20px; }
  p.sub { margin: 4px 0 0; color: #94a3b8; font-size: 14px; }
  main { padding: 32px; display: flex; justify-content: center; }
  .card { background: #ffffff; border-radius: 12px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
  .card img { display: block; max-width: 100%; height: auto; border-radius: 6px; }
  footer { text-align: center; color: #64748b; font-size: 12px; padding: 16px; }
  button { background: #2d78e6; color: white; border: 0; border-radius: 6px; padding: 8px 14px; font-size: 14px; cursor: pointer; }
</style>
</head>
<body>
<header>
  <h1>go-charting-scraper</h1>
  <p class="sub">Scraping {{.Coin}} / {{.Currency}} over the last {{.Days}} days from the CoinGecko API and rendering a live chart.</p>
</header>
<main>
  <div class="card">
    <img id="chart" src="/chart.png" alt="{{.Coin}} price chart">
    <div style="margin-top:12px;text-align:center;">
      <button onclick="document.getElementById('chart').src='/chart.png?ts='+Date.now()">Refresh</button>
    </div>
  </div>
</main>
<footer>Data source: CoinGecko public API</footer>
</body>
</html>`))
