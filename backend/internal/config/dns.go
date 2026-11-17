package config

import (
	"errors"
	"time"

	"ldos/backend/internal/network"
)

type EncryptedDNS struct {
	Enabled          bool    `json:"enabled"`
	Endpoint         string  `json:"endpoint"`
	TimeoutSeconds   float64 `json:"timeout_seconds"`
	MaxResponseBytes int64   `json:"max_response_bytes"`
}

func defaultEncryptedDNS() EncryptedDNS {
	return EncryptedDNS{true, network.DefaultDoHEndpoint, 8, 64 * 1024}
}
func (d *EncryptedDNS) normalize() error {
	endpoint, err := network.NormalizeDoHEndpoint(d.Endpoint)
	if err != nil {
		return err
	}
	d.Endpoint = endpoint
	if d.TimeoutSeconds < .1 || d.TimeoutSeconds > 60 {
		return errors.New("encrypted_dns.timeout_seconds 必须位于 0.1..60")
	}
	if d.MaxResponseBytes < 1024 || d.MaxResponseBytes > 1048576 {
		return errors.New("encrypted_dns.max_response_bytes 必须位于 1024..1048576")
	}
	return nil
}
func (d EncryptedDNS) RuntimeSettings() network.DNSSettings {
	return network.DNSSettings{Enabled: d.Enabled, Endpoint: d.Endpoint, Timeout: time.Duration(d.TimeoutSeconds * float64(time.Second)), MaxResponseBytes: d.MaxResponseBytes}
}
