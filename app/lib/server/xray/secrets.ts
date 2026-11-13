/**
 * What a leaked credential looks like: by a file's name, and by what's inside it.
 * Pure functions, so they're tested without a bucket. Nothing here ever returns the
 * secret itself — only which rule matched and on which line.
 */
export type SecretRule = { rule: string; severity: "high" | "medium" };

const base = (key: string) => key.slice(key.lastIndexOf("/") + 1).toLowerCase();

/** Example and template files hold placeholders, not secrets. */
const PLACEHOLDER = /\.(example|sample|template|dist|tpl)$|[-_.]example\b/;

const NAME_RULES: { test: (name: string, key: string) => boolean; rule: string; severity: "high" | "medium" }[] = [
  { test: (n) => n === ".env" || n.startsWith(".env.") || n.endsWith(".env"), rule: "Environment file (.env)", severity: "high" },
  { test: (n) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(n), rule: "SSH private key", severity: "high" },
  { test: (n) => /\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(n), rule: "Private key or certificate store", severity: "high" },
  { test: (n, k) => n === "credentials" && /(^|\/)\.aws\//.test(k), rule: "AWS credentials file", severity: "high" },
  { test: (n) => n === "credentials.json" || /^service[-_]?account.*\.json$/.test(n), rule: "Cloud service-account key", severity: "high" },
  { test: (n) => n === ".git-credentials" || n === ".netrc" || n === ".npmrc" || n === ".pypirc" || n === ".dockercfg", rule: "Tool credentials file", severity: "high" },
  { test: (n, k) => n === "config.json" && /(^|\/)\.docker\//.test(k), rule: "Docker registry credentials", severity: "high" },
  { test: (n) => n === ".htpasswd" || n === "shadow", rule: "Password file", severity: "high" },
  { test: (n) => n.startsWith("terraform.tfstate") || n.endsWith(".tfstate") || n.endsWith(".tfvars"), rule: "Terraform state or variables", severity: "high" },
  { test: (n, k) => n === "kubeconfig" || (n === "config" && /(^|\/)\.kube\//.test(k)), rule: "Kubernetes credentials", severity: "high" },
  { test: (n) => n === "wp-config.php", rule: "WordPress configuration", severity: "high" },
  { test: (n) => /^secrets?\.(ya?ml|json|toml)$/.test(n), rule: "Secrets file", severity: "high" },
  { test: (n) => n.endsWith(".ovpn"), rule: "VPN profile", severity: "medium" },
  { test: (n, k) => n === "config" && /(^|\/)\.git\//.test(k), rule: "Git repository (may hold tokens in its config)", severity: "medium" },
  { test: (n) => /\.(sql|dump|bak)(\.(gz|zst|bz2|zip))?$/.test(n), rule: "Database dump or backup", severity: "medium" },
];

/** Whether a file's name alone says it's likely to hold credentials. */
export function nameRule(key: string): SecretRule | null {
  const name = base(key);
  if (PLACEHOLDER.test(name)) return null;
  const hit = NAME_RULES.find((entry) => entry.test(name, key.toLowerCase()));
  return hit ? { rule: hit.rule, severity: hit.severity } : null;
}

const TEXT_EXTENSIONS = new Set([
  "env", "json", "yml", "yaml", "txt", "cfg", "conf", "config", "ini", "properties", "sh", "bash", "zsh", "py", "js", "mjs", "ts", "rb", "php", "go",
  "tf", "tfvars", "tfstate", "xml", "toml", "pem", "key", "ovpn", "csv", "md", "log", "ipynb", "pypirc", "npmrc", "netrc",
]);

/** Small text files are worth opening; everything else is judged by name only. */
export function worthReading(key: string, size: number, maxBytes: number): boolean {
  if (size === 0 || size > maxBytes) return false;
  const name = base(key);
  if (PLACEHOLDER.test(name)) return false;
  const dot = name.lastIndexOf(".");
  // Dotfiles and extensionless files (".env", "credentials", "Dockerfile") are usually text.
  if (dot <= 0) return size <= 64 * 1024;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1));
}

const CONTENT_RULES: { pattern: RegExp; rule: string; severity: "high" | "medium" }[] = [
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY/, rule: "Private key", severity: "high" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, rule: "AWS access key", severity: "high" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/, rule: "GitHub token", severity: "high" },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/, rule: "GitLab token", severity: "high" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, rule: "Slack token", severity: "high" },
  { pattern: /\b[sr]k_live_[0-9a-zA-Z]{24,}\b/, rule: "Stripe live key", severity: "high" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, rule: "Google API key", severity: "high" },
  { pattern: /"type"\s*:\s*"service_account"/, rule: "Google service-account key", severity: "high" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, rule: "Anthropic API key", severity: "high" },
  { pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/, rule: "OpenAI-style API key", severity: "high" },
  { pattern: /\bSG\.[\w-]{22}\.[\w-]{43}\b/, rule: "SendGrid key", severity: "high" },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/, rule: "npm token", severity: "high" },
  { pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s/]+/i, rule: "Database URL with a password", severity: "high" },
  { pattern: /AccountKey=[A-Za-z0-9+/=]{60,}/, rule: "Azure storage account key", severity: "high" },
  {
    pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["']?(?!\$\{|<|xxx|changeme|your[-_]|example|null\b|true\b|false\b)[^\s"'#]{12,}/i,
    rule: "Hard-coded password or token",
    severity: "medium",
  },
];

/** Every rule a text matches, once each, with the first line it matched on. */
export function scanText(text: string): (SecretRule & { line: number })[] {
  const hits: (SecretRule & { line: number })[] = [];
  const lines = text.split("\n");
  for (const entry of CONTENT_RULES) {
    const line = lines.findIndex((value) => value.length <= 4000 && entry.pattern.test(value));
    if (line >= 0) hits.push({ rule: entry.rule, severity: entry.severity, line: line + 1 });
  }
  return hits;
}
