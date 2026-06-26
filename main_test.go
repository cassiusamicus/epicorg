package main

import (
	"reflect"
	"testing"
)

func TestReorderArgs(t *testing.T) {
	cases := []struct {
		name           string
		args           []string
		wantFlags      []string
		wantPositional []string
	}{
		{
			name:           "flags before positional",
			args:           []string{"-addr", ":8080", "-file", "x.org", "dir"},
			wantFlags:      []string{"-addr", ":8080", "-file", "x.org"},
			wantPositional: []string{"dir"},
		},
		{
			name:           "positional before flags",
			args:           []string{"dir", "-file", "x.org"},
			wantFlags:      []string{"-file", "x.org"},
			wantPositional: []string{"dir"},
		},
		{
			name:           "flags interleaved with positional",
			args:           []string{"-addr", ":9090", "dir", "-file", "x.org"},
			wantFlags:      []string{"-addr", ":9090", "-file", "x.org"},
			wantPositional: []string{"dir"},
		},
		{
			name:           "flag=value form",
			args:           []string{"dir", "-file=x.org"},
			wantFlags:      []string{"-file=x.org"},
			wantPositional: []string{"dir"},
		},
		{
			name:           "no flags",
			args:           []string{"dir"},
			wantFlags:      nil,
			wantPositional: []string{"dir"},
		},
		{
			name:           "no positional",
			args:           []string{"-file", "x.org"},
			wantFlags:      []string{"-file", "x.org"},
			wantPositional: nil,
		},
		{
			name:           "unknown flag passed through without consuming next token",
			args:           []string{"-h", "dir"},
			wantFlags:      []string{"-h"},
			wantPositional: []string{"dir"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			flags, positional := reorderArgs(c.args)
			if !reflect.DeepEqual(flags, c.wantFlags) {
				t.Errorf("flags = %v, want %v", flags, c.wantFlags)
			}
			if !reflect.DeepEqual(positional, c.wantPositional) {
				t.Errorf("positional = %v, want %v", positional, c.wantPositional)
			}
		})
	}
}
