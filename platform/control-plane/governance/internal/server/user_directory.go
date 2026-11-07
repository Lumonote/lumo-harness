package server

import (
	"fmt"
	"net/url"
	"strconv"

	"github.com/lumo-harness/platform/governance/internal/store"
)

func parseUserDirectoryOptions(query url.Values) (store.UserDirectoryOptions, error) {
	options := store.UserDirectoryOptions{Limit: 200}
	for _, key := range []string{"q", "status", "department_id", "limit", "offset"} {
		if len(query[key]) > 1 {
			return options, fmt.Errorf("%w: repeated %s", store.ErrBadRequest, key)
		}
	}
	options.Query = query.Get("q")
	options.Status = query.Get("status")
	options.DepartmentID = query.Get("department_id")
	for key, target := range map[string]*int{"limit": &options.Limit, "offset": &options.Offset} {
		if values, exists := query[key]; exists {
			if len(values) != 1 || values[0] == "" {
				return options, fmt.Errorf("%w: invalid %s", store.ErrBadRequest, key)
			}
			for _, digit := range values[0] {
				if digit < '0' || digit > '9' {
					return options, fmt.Errorf("%w: invalid %s", store.ErrBadRequest, key)
				}
			}
			value, err := strconv.Atoi(values[0])
			if err != nil {
				return options, fmt.Errorf("%w: invalid %s", store.ErrBadRequest, key)
			}
			*target = value
		}
	}
	return options, options.Normalize()
}
