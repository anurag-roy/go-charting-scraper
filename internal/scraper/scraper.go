// Package scraper fetches historical market price data from a
// CoinGecko-compatible HTTP API and normalizes it into a time series.
package scraper

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"
)

// DefaultBaseURL is the public CoinGecko API root.
const DefaultBaseURL = "https://api.coingecko.com/api/v3"

// PricePoint is a single timestamped price observation.
type PricePoint struct {
	Time  time.Time
	Price float64
}

// Series is an ordered collection of price points for one asset.
type Series struct {
	Asset    string
	Currency string
	Points   []PricePoint
}

// First returns the earliest point, ok=false when the series is empty.
func (s *Series) First() (PricePoint, bool) {
	if len(s.Points) == 0 {
		return PricePoint{}, false
	}
	return s.Points[0], true
}

// Last returns the most recent point, ok=false when the series is empty.
func (s *Series) Last() (PricePoint, bool) {
	if len(s.Points) == 0 {
		return PricePoint{}, false
	}
	return s.Points[len(s.Points)-1], true
}

// Client scrapes market chart data from a CoinGecko-compatible API.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// New returns a Client with sensible production defaults.
func New() *Client {
	return &Client{
		BaseURL: DefaultBaseURL,
		HTTP:    &http.Client{Timeout: 20 * time.Second},
	}
}

type marketChartResponse struct {
	// Each entry is [unix_millis, price]. JSON numbers decode to float64.
	Prices [][2]float64 `json:"prices"`
}

// FetchMarketChart scrapes the price history for the given coin/currency over
// the requested number of days. It returns a chronologically sorted series.
func (c *Client) FetchMarketChart(ctx context.Context, coin, currency string, days int) (*Series, error) {
	if coin == "" {
		return nil, fmt.Errorf("scraper: coin must not be empty")
	}
	if currency == "" {
		return nil, fmt.Errorf("scraper: currency must not be empty")
	}
	if days <= 0 {
		return nil, fmt.Errorf("scraper: days must be positive, got %d", days)
	}

	endpoint := fmt.Sprintf("%s/coins/%s/market_chart", c.BaseURL, url.PathEscape(coin))
	q := url.Values{}
	q.Set("vs_currency", currency)
	q.Set("days", strconv.Itoa(days))
	reqURL := endpoint + "?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("scraper: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "go-charting-scraper/1.0 (+https://github.com/anurag-roy/go-charting-scraper)")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("scraper: request %s: %w", coin, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("scraper: read body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("scraper: unexpected status %d for %s: %s", resp.StatusCode, coin, truncate(string(body), 200))
	}

	var parsed marketChartResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("scraper: decode response: %w", err)
	}
	if len(parsed.Prices) == 0 {
		return nil, fmt.Errorf("scraper: no price data returned for %s/%s", coin, currency)
	}

	points := make([]PricePoint, 0, len(parsed.Prices))
	for _, pair := range parsed.Prices {
		ms := int64(pair[0])
		points = append(points, PricePoint{
			Time:  time.UnixMilli(ms).UTC(),
			Price: pair[1],
		})
	}
	sort.Slice(points, func(i, j int) bool {
		return points[i].Time.Before(points[j].Time)
	})

	return &Series{Asset: coin, Currency: currency, Points: points}, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
