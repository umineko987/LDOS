package atlas

func (s *Service) pythonExecutable() string {
	if s.deps.PythonExecutable != nil {
		return s.deps.PythonExecutable()
	}
	return s.deps.Settings.Dedup.PythonExecutable
}
