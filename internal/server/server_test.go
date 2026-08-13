package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/anurag-roy/go-charting-scraper/internal/scraper"
)

type fakeFetcher struct {
	calls int32
	err   error
}

func (f *fakeFetcher) FetchMarketChart(_ context.Context, coin, currency string, days int) (*scraper.Series, error) {
	atomic.AddInt32(&f.calls, 1)
	if f.err != nil {
		return nil, f.err
	}
	base := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	pts := make([]scraper.PricePoint, days)
	for i := range pts {
		pts[i] = scraper.PricePoint{Time: base.Add(time.Duration(i) * time.Hour), Price: 100 + float64(i)}
	}
	return &scraper.Series{Asset: coin, Currency: currency, Points: pts}, nil
}

func TestIndexServesHTML(t *testing.T) {
	s := New(&fakeFetcher{}, Config{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "go-charting-scraper") {
		t.Errorf("index missing title; body: %s", body[:min(200, len(body))])
	}
	if !strings.Contains(body, "/chart.png") {
		t.Error("index missing chart image reference")
	}
}

func TestChartEndpointReturnsPNG(t *testing.T) {
	s := New(&fakeFetcher{}, Config{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/chart.png", nil)
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("content-type = %q, want image/png", ct)
	}
	if rec.Body.Len() == 0 {
		t.Error("empty chart body")
	}
}

func TestChartEndpointCachesDefault(t *testing.T) {
	f := &fakeFetcher{}
	s := New(f, Config{CacheTTL: time.Minute})
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/chart.png", nil)
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status %d", i, rec.Code)
		}
	}
	if got := atomic.LoadInt32(&f.calls); got != 1 {
		t.Errorf("fetcher called %d times, want 1 (cached)", got)
	}
}

func TestChartEndpointUpstreamError(t *testing.T) {
	s := New(&fakeFetcher{err: context.DeadlineExceeded}, Config{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/chart.png", nil)
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}

func TestHealthz(t *testing.T) {
	s := New(&fakeFetcher{}, Config{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("healthz = %d %q", rec.Code, rec.Body.String())
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
