package datasetstages

func (s *Service) dedupEnabled() bool {
	if s.deps.DedupEnabled != nil {
		return s.deps.DedupEnabled()
	}
	return s.deps.Settings.Dedup.Enabled
}
