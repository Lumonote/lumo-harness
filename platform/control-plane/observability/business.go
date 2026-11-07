package observability

// Business operations/results are a closed vocabulary. Never add session,
// realm, user, project, connector or receipt identities as metric labels.
type BusinessOperation string
type BusinessOutcome string

const (
	BusinessSessionExecutionNode  BusinessOperation = "session_execution_node"
	BusinessSessionExecutionLease BusinessOperation = "session_execution_lease"
	BusinessSessionAttachment     BusinessOperation = "session_attachment"
	BusinessReviewFileRead        BusinessOperation = "review_file_read"
	BusinessConnectorRequest      BusinessOperation = "connector_request"
	BusinessConnectorInvoke       BusinessOperation = "connector_invoke"

	BusinessSuccess     BusinessOutcome = "success"
	BusinessInvalid     BusinessOutcome = "invalid"
	BusinessFenced      BusinessOutcome = "fenced"
	BusinessConflict    BusinessOutcome = "conflict"
	BusinessNotFound    BusinessOutcome = "not_found"
	BusinessDenied      BusinessOutcome = "denied"
	BusinessUnavailable BusinessOutcome = "unavailable"
	BusinessUnknown     BusinessOutcome = "unknown"
	BusinessFailed      BusinessOutcome = "failed"
)

// ValidBusinessOperation and ValidBusinessOutcome also define the vocabulary
// accepted by the alert contract checker.
func ValidBusinessOperation(operation BusinessOperation) bool {
	switch operation {
	case BusinessSessionExecutionNode, BusinessSessionExecutionLease, BusinessSessionAttachment,
		BusinessReviewFileRead, BusinessConnectorRequest, BusinessConnectorInvoke:
		return true
	}
	return false
}

func ValidBusinessOutcome(outcome BusinessOutcome) bool {
	switch outcome {
	case BusinessSuccess, BusinessInvalid, BusinessFenced, BusinessConflict, BusinessNotFound,
		BusinessDenied, BusinessUnavailable, BusinessUnknown, BusinessFailed:
		return true
	}
	return false
}

// RegisterBusinessOperations publishes zeroes at startup, so increase can see
// the first event after an initial scrape. Add zero preserves existing totals
// if several server instances in one process register the same operation.
func RegisterBusinessOperations(operations ...BusinessOperation) {
	for _, operation := range operations {
		if !ValidBusinessOperation(operation) {
			Default.droppedGauges.Add(1)
			continue
		}
		for _, outcome := range []BusinessOutcome{BusinessSuccess, BusinessInvalid, BusinessFenced,
			BusinessConflict, BusinessNotFound, BusinessDenied, BusinessUnavailable, BusinessUnknown, BusinessFailed} {
			AddGaugeWithLabels("lumo_business_requests_total", 0, map[string]string{
				"operation": string(operation), "outcome": string(outcome),
			})
		}
	}
}

// RecordBusinessResult records a process-lifetime cumulative value, shared by
// Prometheus and OTLP. Invalid enum casts are rejected rather than creating
// unbounded series. The exporter keeps its existing cumulative-gauge format;
// alerts use increase so process restarts do not look like recovery events.
func RecordBusinessResult(operation BusinessOperation, outcome BusinessOutcome) {
	if !ValidBusinessOperation(operation) || !ValidBusinessOutcome(outcome) {
		Default.droppedGauges.Add(1)
		return
	}
	AddGaugeWithLabels("lumo_business_requests_total", 1, map[string]string{
		"operation": string(operation), "outcome": string(outcome),
	})
}
