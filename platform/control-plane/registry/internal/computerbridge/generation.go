package computerbridge

import (
	"os"
	"sync"
)

// Retain the descriptor even if a failed shutdown makes its caller unreachable.
// An os.File finalizer must not silently release an unconfirmed generation.
var generationFiles sync.Map

func retainGeneration(file *os.File) func() {
	generationFiles.Store(file, struct{}{})
	var once sync.Once
	return func() { once.Do(func() { _ = file.Close(); generationFiles.Delete(file) }) }
}
