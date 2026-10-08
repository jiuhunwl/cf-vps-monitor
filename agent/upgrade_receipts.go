package main

import "encoding/json"

const maxUpgradeResultsPerEnvelope = 16

// Missing/malformed optional receipt fields never authorize dropping a result.
type upgradeReceiptIDs []string

func (ids *upgradeReceiptIDs) UnmarshalJSON(raw []byte) error {
	*ids = nil
	if len(raw) > 4096 {
		return nil
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil || len(values) > maxUpgradeResultsPerEnvelope {
		return nil
	}
	for _, id := range values {
		if id == "" || len(id) > 128 {
			return nil
		}
	}
	*ids = values
	return nil
}

// A receipt is valid only for a result in this exact transmitted batch. Keep
// concurrent arrivals and changed same-ID payloads. Never unlink the result
// pathname here: a supervisor may already have replaced it with newer data.
func (m *upgradeManager) acknowledge(sent []Report, accepted upgradeReceiptIDs) {
	if len(accepted) == 0 || len(accepted) > maxUpgradeResultsPerEnvelope {
		return
	}
	acceptedSet := make(map[string]bool, len(accepted))
	for _, id := range accepted {
		acceptedSet[id] = true
	}
	sentByID := make(map[string]upgradeResult)
	ambiguous := make(map[string]bool)
	for _, report := range sent {
		for _, result := range report.UpgradeResults {
			if !acceptedSet[result.CommandID] {
				continue
			}
			if prior, ok := sentByID[result.CommandID]; ok && prior != result {
				ambiguous[result.CommandID] = true
			}
			sentByID[result.CommandID] = result
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	retained := m.pending[:0]
	for _, result := range m.pending {
		actual, wasSent := sentByID[result.CommandID]
		if wasSent && !ambiguous[result.CommandID] && actual == result {
			continue
		}
		retained = append(retained, result)
	}
	for i := len(retained); i < len(m.pending); i++ {
		m.pending[i] = upgradeResult{}
	}
	m.pending = retained
}
