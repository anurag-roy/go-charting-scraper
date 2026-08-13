// Package chart renders scraped price series into PNG line charts.
package chart

import (
	"bytes"
	"fmt"

	gochart "github.com/wcharczuk/go-chart/v2"
	"github.com/wcharczuk/go-chart/v2/drawing"

	"github.com/anurag-roy/go-charting-scraper/internal/scraper"
)

// RenderLineChart renders a price series as a PNG line chart and returns the
// encoded bytes. It returns an error when the series has no data.
func RenderLineChart(s *scraper.Series) ([]byte, error) {
	if s == nil || len(s.Points) == 0 {
		return nil, fmt.Errorf("chart: no data points to render")
	}

	xs := make([]float64, len(s.Points))
	ys := make([]float64, len(s.Points))
	for i, p := range s.Points {
		xs[i] = float64(p.Time.UnixMilli())
		ys[i] = p.Price
	}

	primary := drawing.Color{R: 45, G: 120, B: 230, A: 255}
	graph := gochart.Chart{
		Title:  fmt.Sprintf("%s price (%s)", s.Asset, s.Currency),
		Width:  1000,
		Height: 500,
		Background: gochart.Style{
			Padding: gochart.Box{Top: 40, Left: 20, Right: 30, Bottom: 20},
		},
		XAxis: gochart.XAxis{
			Name:           "Time",
			ValueFormatter: gochart.TimeValueFormatterWithFormat("Jan 02"),
		},
		YAxis: gochart.YAxis{
			Name: fmt.Sprintf("Price (%s)", s.Currency),
			ValueFormatter: func(v interface{}) string {
				if f, ok := v.(float64); ok {
					return fmt.Sprintf("%.0f", f)
				}
				return ""
			},
		},
		Series: []gochart.Series{
			gochart.ContinuousSeries{
				Name:    s.Asset,
				XValues: xs,
				YValues: ys,
				Style: gochart.Style{
					StrokeColor: primary,
					StrokeWidth: 2.5,
					FillColor:   primary.WithAlpha(40),
				},
			},
		},
	}

	var buf bytes.Buffer
	if err := graph.Render(gochart.PNG, &buf); err != nil {
		return nil, fmt.Errorf("chart: render png: %w", err)
	}
	return buf.Bytes(), nil
}
