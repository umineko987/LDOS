package network

import "context"

// URLValidator checks URL syntax without resolving hostnames. DNS belongs to the
// actual direct connection or selected proxy, not request admission.
type URLValidator struct {
	AllowPrivate bool
}

func (v URLValidator) ValidateStatic(value string) (Target, error) {
	return ValidateSyntax(value, v.AllowPrivate)
}

func (v URLValidator) ValidateDirect(ctx context.Context, value string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	_, err := v.ValidateStatic(value)
	return nil, err
}

func (v URLValidator) ValidateProxy(ctx context.Context, value, _ string) ([]string, error) {
	return v.ValidateDirect(ctx, value)
}
