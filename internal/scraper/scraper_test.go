package scraper

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFetchMarketChartParsesAndSorts(t *testing.T) {
	// Intentionally out-of-order timestamps to verify sorting.
	body := `{"prices":[[1700003600000,101.5],[1700000000000,100.0],[1700007200000,102.25]]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("vs_currency"); got != "usd" {
			t.Errorf("vs_currency = %q, want usd", got)
		}
		if got := r.URL.Query().Get("days"); got != "7" {
			t.Errorf("days = %q, want 7", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, HTTP: srv.Client()}
	series, err := c.FetchMarketChart(context.Background(), "bitcoin", "usd", 7)
	if err != nil {
		t.Fatalf("FetchMarketChart: %v", err)
	}
	if len(series.Points) != 3 {
		t.Fatalf("got %d points, want 3", len(series.Points))
	}
	if !series.Points[0].Time.Before(series.Points[1].Time) ||
		!series.Points[1].Time.Before(series.Points[2].Time) {
		t.Errorf("points are not sorted ascending: %+v", series.Points)
	}
	first, _ := series.First()
	if first.Price != 100.0 {
		t.Errorf("first price = %v, want 100.0", first.Price)
	}
	last, _ := series.Last()
	if last.Price != 102.25 {
		t.Errorf("last price = %v, want 102.25", last.Price)
	}
	wantTime := time.UnixMilli(1700000000000).UTC()
	if !first.Time.Equal(wantTime) {
		t.Errorf("first time = %v, want %v", first.Time, wantTime)
	}
}

func TestFetchMarketChartErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate limited"}`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, HTTP: srv.Client()}
	if _, err := c.FetchMarketChart(context.Background(), "bitcoin", "usd", 7); err == nil {
		t.Fatal("expected error for non-200 status, got nil")
	}
}

func TestFetchMarketChartValidation(t *testing.T) {
	c := New()
	cases := []struct {
		name           string
		coin, currency string
		days           int
	}{
		{"empty coin", "", "usd", 7},
		{"empty currency", "bitcoin", "", 7},
		{"zero days", "bitcoin", "usd", 0},
		{"negative days", "bitcoin", "usd", -1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := c.FetchMarketChart(context.Background(), tc.coin, tc.currency, tc.days); err == nil {
				t.Errorf("expected validation error for %s", tc.name)
			}
		})
	}
}
