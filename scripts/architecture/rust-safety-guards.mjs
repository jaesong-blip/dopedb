const poisonPanicLock = /\.lock\(\)\s*\.(?:unwrap|expect)\s*\(/;

function productionRust(read, filePath) {
  return read(filePath)
    .replace(/\r\n/g, "\n")
    .split(/\n#\[cfg\([^\n]*\)\]\nmod tests \{/)[0];
}

export function collectPoisonMutexDiagnostics({ read, relative, sourceFiles }) {
  const diagnostics = [];
  const productionFixture =
    "fn run(mutex: &Mutex<u8>) {\r\nmutex.lock()\r\n.unwrap();\r\n}\r\n";
  const testFixture =
    "fn run() {}\r\n#[cfg(test)]\r\nmod tests {\r\nmutex.lock().expect(\"fixture\");\r\n}\r\n";
  if (
    !poisonPanicLock.test(
      productionRust(() => productionFixture, "production.rs"),
    ) ||
    poisonPanicLock.test(productionRust(() => testFixture, "tests.rs"))
  ) {
    diagnostics.push("poisoning Mutex architecture guard self-test failed");
  }

  for (const file of sourceFiles.filter((sourceFile) =>
    sourceFile.endsWith(".rs"),
  )) {
    const filePath = relative(file);
    if (
      /(?:^|\/)(?:tests|[^/]+_tests)\.rs$/.test(filePath) ||
      /\.(?:test|spec)\.[^.]+$/.test(filePath)
    ) {
      continue;
    }
    if (poisonPanicLock.test(productionRust(read, filePath))) {
      diagnostics.push(
        `${filePath}: production Mutex locks must use kernel::sync::lock_unpoisoned instead of panic-on-poison access`,
      );
    }
  }
  return diagnostics;
}
