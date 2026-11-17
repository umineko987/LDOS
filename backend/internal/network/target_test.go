package network

import (
	"reflect"
	"testing"
)

func TestValidateSyntax(t *testing.T) {
	for _, tc := range []struct {
		url, host string
		port      int
	}{
		{" HTTPS://TÄST.Example.:8443/a ", "xn--tst-qla.example", 8443},
		{"https://faß.de/", "fass.de", 443},
		{"http://8.8.8.8/", "8.8.8.8", 80},
		{"https://[::ffff:8.8.8.8]/", "::ffff:808:808", 443},
		{"https://[2001:4860:4860::8888]/", "2001:4860:4860::8888", 443},
	} {
		t.Run(tc.url, func(t *testing.T) {
			got, err := ValidateSyntax(tc.url, false)
			if err != nil || got.Hostname != tc.host || got.Port != tc.port {
				t.Fatalf("got %+v, %v", got, err)
			}
		})
	}
	for _, value := range []string{"ftp://example.com/", "https://user:secret@example.com/", "https://bad_name.example/", "https://example.com:0/", "https://example.com:65536/", "https://example.com:abc/", "https://[fe80::1%25eth0]/", "https://example.com/a b", "https://localhost/", "https://localhost.localdomain/", "https://printer.local/", "http://127.0.0.1/", "https://[::ffff:127.0.0.1]/", "https://[2001::4a56:cac]/"} {
		t.Run(value, func(t *testing.T) {
			if _, err := ValidateSyntax(value, false); err == nil {
				t.Fatal("accepted invalid/private target")
			}
		})
	}
	for _, value := range []string{"http://127.0.0.1:8080/", "https://printer.local/"} {
		if _, err := ValidateSyntax(value, true); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ValidateSyntax("https://[fe80::1%25eth0]/", true); err == nil {
		t.Fatal("allowPrivate must not allow zone identifiers")
	}
}

func TestValidateAddresses(t *testing.T) {
	for _, tc := range []struct {
		name            string
		input           []string
		private, strict bool
		want            []string
		fail            bool
	}{
		{"normalize deduplicate", []string{" 8.8.8.8 ", "8.8.8.8", "2001:4860:4860:0:0:0:0:8888%eth0"}, false, true, []string{"8.8.8.8", "2001:4860:4860::8888"}, false},
		{"mapped public", []string{"::ffff:8.8.8.8"}, false, true, []string{"::ffff:808:808"}, false},
		{"mixed strict", []string{"8.8.8.8", "10.0.0.1"}, false, true, nil, true},
		{"mixed permissive", []string{"bad", "8.8.8.8", "10.0.0.1"}, false, false, []string{"8.8.8.8", "10.0.0.1"}, false},
		{"private permissive", []string{"127.0.0.1"}, false, false, nil, true},
		{"private allowed", []string{"fd00::1"}, true, true, []string{"fd00::1"}, false},
		{"invalid strict", []string{"8.8.8.8", "bad"}, true, true, nil, true},
		{"empty", nil, true, false, nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateAddresses(tc.input, tc.private, tc.strict)
			if (err != nil) != tc.fail || (!tc.fail && !reflect.DeepEqual(got, tc.want)) {
				t.Fatalf("got %v, %v; want %v fail=%v", got, err, tc.want, tc.fail)
			}
		})
	}
	for _, ip := range []string{"0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "203.0.113.1", "::1", "::ffff:127.0.0.1", "2001::4a56:cac", "2001:db8::1", "2002::1", "fc00::1", "fe80::1"} {
		t.Run(ip, func(t *testing.T) {
			if _, err := ValidateAddresses([]string{ip}, false, true); err == nil {
				t.Fatal("accepted non-public address")
			}
		})
	}
	for _, ip := range []string{"192.0.0.9", "192.0.0.10", "2001:1::1", "2001:3::1", "2001:20::1"} {
		if _, err := ValidateAddresses([]string{ip}, false, true); err != nil {
			t.Fatalf("public exception %s: %v", ip, err)
		}
	}
}

func TestNormalizeDoHEndpoint(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{" HTTPS://Cloudflare-DNS.com:443/dns-query ", "https://cloudflare-dns.com:443/dns-query"},
		{"https://[2606:4700:4700::1111]/dns-query", "https://[2606:4700:4700::1111]/dns-query"},
		{"https://TÄST.example/dns-query", "https://xn--tst-qla.example/dns-query"},
	} {
		got, err := NormalizeDoHEndpoint(tc.input)
		if err != nil || got != tc.want {
			t.Fatalf("%s: %q %v", tc.input, got, err)
		}
	}
	for _, value := range []string{"http://dns.example/dns-query", "https://127.0.0.1/dns-query", "https://[::ffff:127.0.0.1]/dns-query", "https://dns.local/dns-query", "https://user:secret@dns.example/dns-query", "https://dns.example/dns-query?name=private.example", "https://dns.example/dns-query#fragment", "https://dns.example/", "https://dns.example", "https://dns.example:0/dns-query"} {
		t.Run(value, func(t *testing.T) {
			if _, err := NormalizeDoHEndpoint(value); err == nil {
				t.Fatal("accepted endpoint")
			}
		})
	}
}
