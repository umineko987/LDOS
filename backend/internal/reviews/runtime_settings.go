package reviews

func (s *Service) pythonExecutable() string {
	if s.deps.PythonExecutable != nil {
		return s.deps.PythonExecutable()
	}
	return s.deps.Dedup.PythonExecutable
}
