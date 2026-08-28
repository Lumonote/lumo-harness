package jsonlzstd

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestRoundTripStrictJSONLZstd(t *testing.T) {
	records := []json.RawMessage{
		json.RawMessage(`{"type":"header","nested":{"name":"lumo"}}`),
		json.RawMessage(`{"type":"footer","count":1}`),
	}
	raw, err := Encode(records, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := Decode(raw, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(records) || string(got[0]) != string(records[0]) || string(got[1]) != string(records[1]) {
		t.Fatalf("round trip = %q", got)
	}
}

func TestEncodeRejectsDuplicateKeys(t *testing.T) {
	_, err := Encode([]json.RawMessage{json.RawMessage(`{"type":"header","type":"footer"}`)}, Limits{})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}

func TestDecodeRejectsRecordOverLimit(t *testing.T) {
	raw, err := Encode([]json.RawMessage{json.RawMessage(`{"type":"header","value":"long"}`)}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = Decode(raw, Limits{MaxLineBytes: 8})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}
