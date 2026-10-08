package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Use a certificate-trusting TLS test transport, never InsecureSkipVerify.
func withUpgradeTLSTransport(t *testing.T, server *httptest.Server) {
	t.Helper()
	original := upgradeTransport
	upgradeTransport = func(string) http.RoundTripper { return server.Client().Transport }
	t.Cleanup(func() { upgradeTransport = original })
}

func TestUpgradeDownloadRejectsHTTPBeforeNetworkOrFileWrite(t *testing.T) {
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits++ }))
	defer server.Close()
	destination := filepath.Join(t.TempDir(), "binary")
	if err := downloadToFile(server.URL+"/binary", destination, upgradeOptions{}); err == nil {
		t.Fatal("HTTP download accepted")
	}
	if hits != 0 {
		t.Fatalf("HTTP server received %d requests", hits)
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("destination created: %v", err)
	}
}

func TestUpgradeDownloadRedirectPolicy(t *testing.T) {
	insecureHits := 0
	insecure := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { insecureHits++ }))
	defer insecure.Close()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/safe":
			http.Redirect(w, r, "/binary?signature=synthetic", http.StatusFound)
		case "/downgrade":
			http.Redirect(w, r, insecure.URL+"/binary", http.StatusFound)
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		case "/binary":
			_, _ = w.Write([]byte("synthetic-binary"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	withUpgradeTLSTransport(t, server)
	for _, route := range []string{"safe", "downgrade", "loop"} {
		t.Run(route, func(t *testing.T) {
			destination := filepath.Join(t.TempDir(), "binary")
			err := downloadToFile(server.URL+"/"+route, destination, upgradeOptions{})
			if route == "safe" {
				if err != nil {
					t.Fatal(err)
				}
				content, err := os.ReadFile(destination)
				if err != nil || string(content) != "synthetic-binary" {
					t.Fatalf("content=%q err=%v", content, err)
				}
			} else {
				if err == nil {
					t.Fatal("unsafe redirect accepted")
				}
				if _, statErr := os.Stat(destination); !os.IsNotExist(statErr) {
					t.Fatalf("destination created: %v", statErr)
				}
			}
		})
	}
	if insecureHits != 0 {
		t.Fatalf("downgrade reached HTTP server %d times", insecureHits)
	}
}

func TestUpgradeMirrorRequiresHTTPSButConnectProxyAllowsHTTP(t *testing.T) {
	if _, _, err := parseUpgradeOptions([]string{"--install-ghproxy", "http://mirror.example.test"}, io.Discard); err == nil {
		t.Fatal("HTTP mirror accepted")
	}
	if err := validateUpgradeRequest(upgradeRequest{TargetVersion: "v1.2.3", GhProxy: "http://mirror.example.test"}); err == nil {
		t.Fatal("HTTP request mirror accepted")
	}
	options, _, err := parseUpgradeOptions([]string{"--install-ghproxy", "https://mirror.example.test/", "--proxy", "http://127.0.0.1:1080"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if options.ghProxy != "https://mirror.example.test" || options.proxy != "http://127.0.0.1:1080" {
		t.Fatalf("unexpected options: %+v", options)
	}
	if _, err := resolveLatestReleaseTag(upgradeOptions{ghProxy: "http://mirror.example.test"}); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("unsafe latest URL not rejected before request: %v", err)
	}
}

func TestUpgradeRedirectAllowsSignedCrossHostHTTPS(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "https://release-assets.example.test/object?signature=synthetic&expires=123", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := upgradeDownloadRedirect(request, []*http.Request{{}}); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"https://user:password@example.test/object", "file:///tmp/object", "https:///missing-host"} {
		if err := validateUpgradeDownloadURL(raw); err == nil {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
}
