import { readFileSync } from "node:fs";

export function hostMemorySummary(samples) {
  const available = samples.flatMap((sample) => sample.available ?? []);
  const swap = samples.flatMap((sample) => sample.swap ?? []);
  const first = samples[0];
  const last = samples.at(-1);
  return {
    minAvailableMiB: available.length ? Math.min(...available) : null,
    swapGrowthMiB:
      first?.swap == null ? null : Math.round((Math.max(...swap) - first.swap) * 1024) / 1024,
    oomKills:
      first?.oomKills != null && last?.oomKills != null && last.oomKills >= first.oomKills
        ? last.oomKills - first.oomKills
        : null,
  };
}

function procText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    // A counter may be unavailable in this kernel or hidden by the environment.
    return "";
  }
}

export function readHostMemory(meminfo, vmstat) {
  const entries = new Map(
    Array.from(
      meminfo.matchAll(/^(MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/gm),
      ([, key, value]) => [key, Number(value) / 1024],
    ),
  );
  const total = entries.get("SwapTotal");
  const free = entries.get("SwapFree");
  const oomKills = /^oom_kill[ \t]+(\d+)$/m.exec(vmstat)?.[1];
  return {
    available: entries.get("MemAvailable") ?? null,
    swap: total != null && free != null && total >= free ? total - free : null,
    oomKills: oomKills === undefined ? null : Number(oomKills),
  };
}

/** Host counters can include unrelated workloads, unlike process-tree RSS. */
export function sampleHostMemory() {
  const samples = [];
  const sample = () =>
    samples.push(readHostMemory(procText("/proc/meminfo"), procText("/proc/vmstat")));
  sample();
  const timer = setInterval(sample, 2000);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return hostMemorySummary(samples);
    },
  };
}

/** Import the observed window only; historical memwatch TSV did not measure OOM kills. */
export function memwatchSummary(tsv) {
  const [header, ...lines] = tsv.trimEnd().split(/\r?\n/);
  const fields = header.split("\t");
  const available = fields.indexOf("available_mb");
  const swap = fields.indexOf("swap_used_mb");
  if (available < 0 || swap < 0)
    throw new Error("Expected memwatch TSV columns available_mb and swap_used_mb");
  const number = (value) => (value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null);
  return hostMemorySummary(
    lines.filter(Boolean).map((line) => {
      const cells = line.split("\t");
      return { available: number(cells[available]), swap: number(cells[swap]) };
    }),
  );
}
