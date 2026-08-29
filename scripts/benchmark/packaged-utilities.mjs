export function createBenchmarkUtilities(harness) {
  const {
    root,
    prefix,
    execFileSync,
    spawn,
    lstat,
    mkdir,
    realpath,
    rm,
    tmpdir,
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
  } = harness;

  function progress(kind, value) {
    process.stdout.write(`[packaged-benchmark] ${kind}: ${value}\n`);
  }

  function commandText(command, args) {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  }

  function runCommand(command, args, options = {}) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        env: process.env,
        stdio: options.stdio ?? "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0 && signal === null) resolvePromise();
        else reject(new Error(`${command} exited code=${code} signal=${signal}`));
      });
    });
  }

  function isWithin(base, path) {
    if (!isAbsolute(base) || !isAbsolute(path)) return false;
    const offset = relative(base, path);
    return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
  }

  async function prepareOutputPath(requested) {
    const output = resolve(root, requested);
    if (!isWithin(root, output)) {
      throw new Error("benchmark output must stay inside the repository");
    }
    await mkdir(dirname(output), { recursive: true });
    const canonicalRoot = await realpath(root);
    const canonicalParent = await realpath(dirname(output));
    const canonicalOutput = join(canonicalParent, basename(output));
    if (!isWithin(canonicalRoot, canonicalOutput)) {
      throw new Error("benchmark output parent must stay inside the repository");
    }
    try {
      const metadata = await lstat(canonicalOutput);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("benchmark output must be a regular file");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return canonicalOutput;
  }

  async function removeOwnedTemporaryRoot(path) {
    const offset = relative(resolve(tmpdir()), resolve(path));
    if (
      offset.startsWith("..")
      || isAbsolute(offset)
      || !basename(path).startsWith(prefix)
    ) {
      throw new Error("refusing to remove a non-benchmark temporary root");
    }
    await rm(path, { recursive: true, force: true });
  }

  return {
    progress,
    commandText,
    runCommand,
    isWithin,
    prepareOutputPath,
    removeOwnedTemporaryRoot,
  };
}
