package chart

import (
	"bytes"
	"image/png"
	"testing"
	"time"

	"github.com/anurag-roy/go-charting-scraper/internal/scraper"
)

func sampleSeries() *scraper.Series {
	base := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	points := make([]scraper.PricePoint, 0, 10)
	for i := 0; i < 10; i++ {
		points = append(points, scraper.PricePoint{
			Time:  base.Add(time.Duration(i) * 24 * time.Hour),
			Price: 100 + float64(i)*3.5,
		})
	}
	return &scraper.Series{Asset: "bitcoin", Currency: "usd", Points: points}
}

func TestRenderLineChartProducesPNG(t *testing.T) {
	data, err := RenderLineChart(sampleSeries())
	if err != nil {
		t.Fatalf("RenderLineChart: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("rendered chart is empty")
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("output is not valid PNG: %v", err)
	}
	if b := img.Bounds(); b.Dx() == 0 || b.Dy() == 0 {
		t.Fatalf("rendered image has zero dimensions: %v", b)
	}
}

func TestRenderLineChartEmpty(t *testing.T) {
	if _, err := RenderLineChart(&scraper.Series{}); err == nil {
		t.Fatal("expected error for empty series, got nil")
	}
	if _, err := RenderLineChart(nil); err == nil {
		t.Fatal("expected error for nil series, got nil")
	}
}
