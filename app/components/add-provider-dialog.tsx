"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/remote";
import { atRestEncryption } from "../lib/connection-settings";

/** New encrypted stores need at least this; the server checks again (and knows about rclone stores). */
const MIN_PASSPHRASE = 12;
import { PROVIDER_PRESETS, findPreset, isConnectable, type ConnectableKind } from "../lib/storage";
import { CheckIcon, ChevronDown, CloseIcon, ExternalIcon, LockIcon, PlusIcon } from "./icons";
import { WEBSITE_URL } from "../lib/site";

/** Field names match what the server's connect route expects for each cloud. */
export type ConnectValues = { presetId: ConnectableKind; name: string; bucket: string } & Record<string, string>;

type FieldSpec = {
  id: string;
  label: string;
  /** "hidden" fields are sent but never shown — values set by an action. */
  kind?: "text" | "secret" | "textarea" | "select" | "hidden";
  /** For kind "select": [value, label] pairs. */
  options?: [string, string][];
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  /** Required unless this returns false for the current values. */
  required?: boolean | ((values: Record<string, string>) => boolean);
  /** A button above the input: returns values to merge into the form, or an error to show. */
  action?: {
    label: string;
    run: (values: Record<string, string>) => Record<string, string> | string | Promise<Record<string, string> | string>;
  };
  /** Also invalid while this other field is empty — e.g. a code before the step that issues it. */
  needs?: { field: string; message: string };
};

type Schema = {
  bucketLabel: string;
  bucketPlaceholder: string;
  /** Pre-filled when this provider is picked. */
  bucketDefault?: string;
  bucketHint?: string;
  fields: FieldSpec[];
  /** Fills the form for a local Floci emulator; absent for clouds Floci doesn't emulate. */
  floci?: Record<string, string> | (() => Promise<Record<string, string>>);
  flociNote?: string;
  security: React.ReactNode;
};

const ENDPOINT_HINT = "Leave empty for the public cloud. For an emulator such as Floci, enter its URL.";

/** Azurite's documented development key — public by design, not a secret. */
const AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMh0==";

const code = (text: string) => <code className="font-mono text-[11.5px]">{text}</code>;

/**
 * A throwaway RSA key for Floci's OCI emulator, which signs-in nobody and checks no
 * signatures — but the OCI SDK still needs a real key to sign with. Never use it on
 * real Oracle Cloud: register your own API key there.
 */
async function throwawayOciKey(): Promise<Record<string, string>> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const base64 = btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, "$1\n").trim();
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  // OCI fingerprints are MD5, which WebCrypto lacks; the emulator only needs the shape.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki)).slice(0, 16);
  return {
    privateKey: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`,
    fingerprint: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(":"),
  };
}

const WASABI_REGIONS = [
  "us-east-1", "us-east-2", "us-central-1", "us-west-1", "us-west-2", "ca-central-1",
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-south-1",
  "ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2",
];
const SCALEWAY_REGIONS: [string, string][] = [
  ["fr-par", "Paris (fr-par)"], ["nl-ams", "Amsterdam (nl-ams)"], ["pl-waw", "Warsaw (pl-waw)"],
];
const SPACES_REGIONS: [string, string][] = [
  ["nyc3", "New York 3 (nyc3)"], ["sfo2", "San Francisco 2 (sfo2)"], ["sfo3", "San Francisco 3 (sfo3)"],
  ["ams3", "Amsterdam 3 (ams3)"], ["sgp1", "Singapore 1 (sgp1)"], ["fra1", "Frankfurt 1 (fra1)"],
  ["syd1", "Sydney 1 (syd1)"], ["blr1", "Bangalore 1 (blr1)"], ["tor1", "Toronto 1 (tor1)"],
  ["lon1", "London 1 (lon1)"], ["atl1", "Atlanta 1 (atl1)"],
];

/** Shared by the S3-compatible clouds: the endpoint is built on the server, never typed. */
const s3Keys = (accessLabel: string, accessPlaceholder: string, secretLabel = "Secret key"): FieldSpec[] => [
  { id: "accessKeyId", label: accessLabel, placeholder: accessPlaceholder, mono: true },
  { id: "secretAccessKey", label: secretLabel, kind: "secret" },
];
const scopedKeyNote = (where: string) => <>Create a dedicated key for it under {where}.</>;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Dropbox's no-redirect PKCE flow: Dropbox shows the user a code to paste back here, so
 * the server needs no public callback URL and the app needs no client secret.
 */
function allowDropboxAccess(values: Record<string, string>): Record<string, string> | string {
  const appKey = values.appKey?.trim();
  if (!appKey) return "Enter the app key first.";
  // Opened inside the click, before any await: pop-up blockers allow only that.
  const tab = window.open("", "_blank");
  if (!tab) return "Your browser blocked the Dropbox tab — allow pop-ups for this site and try again.";
  tab.opener = null;
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  void crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then((hash) => {
    const url = new URL("https://www.dropbox.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: appKey,
      response_type: "code",
      token_access_type: "offline",
      code_challenge: base64url(new Uint8Array(hash)),
      code_challenge_method: "S256",
    }).toString();
    tab.location.href = url.href;
  });
  return { codeVerifier: verifier, code: "" };
}

/** Where Google sends the browser back; the page there shows the code to paste. */
const DRIVE_CALLBACK_PATH = "/connect/google-drive";

/**
 * Google's authorization-code flow with PKCE. Google sends the browser back to a page on
 * this server that shows the code; it's pasted here, and Connect trades it for a refresh
 * token. The verifier stays in this form, so a code is useless to anyone who only sees it.
 */
function signInWithGoogle(values: Record<string, string>): Record<string, string> | string {
  const clientId = values.clientId?.trim();
  if (!clientId) return "Enter the client ID first.";
  // Opened inside the click, before any await: pop-up blockers allow only that.
  const tab = window.open("", "_blank");
  if (!tab) return "Your browser blocked the Google tab — allow pop-ups for this site and try again.";
  tab.opener = null;
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  void crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then((hash) => {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: window.location.origin + DRIVE_CALLBACK_PATH,
      response_type: "code",
      // Read-only asks Google for read-only access too: then Google itself refuses any change.
      scope: values.readOnly === "true" ? "https://www.googleapis.com/auth/drive.readonly" : "https://www.googleapis.com/auth/drive",
      // A refresh token, every time: without consent Google only sends one the first time.
      access_type: "offline",
      prompt: "consent",
      code_challenge: base64url(new Uint8Array(hash)),
      code_challenge_method: "S256",
    }).toString();
    tab.location.href = url.href;
  });
  return { codeVerifier: verifier, code: "" };
}

/**
 * Microsoft's device-code flow: the server asks Microsoft for a short code, the user types
 * it at microsoft.com, and Connect redeems it — so no callback URL and no client secret.
 */
async function signInWithMicrosoft(values: Record<string, string>): Promise<Record<string, string> | string> {
  const clientId = values.clientId?.trim();
  if (!clientId) return "Enter the application (client) ID first.";
  // Opened inside the click, before any await: pop-up blockers allow only that.
  const tab = window.open("", "_blank");
  if (!tab) return "Your browser blocked the Microsoft tab — allow pop-ups for this site and try again.";
  tab.opener = null;
  try {
    const signIn = await api.oneDriveSignIn(clientId, values.tenant?.trim() ?? "");
    tab.location.href = signIn.verificationUri;
    return { signIn: signIn.handle, userCode: signIn.userCode };
  } catch (error) {
    tab.close();
    return error instanceof Error ? error.message : "Couldn't start the Microsoft sign-in.";
  }
}

const SCHEMAS: Record<ConnectableKind, Schema> = {
  gdrive: {
    bucketLabel: "Folder",
    bucketPlaceholder: "/",
    bucketDefault: "/",
    bucketHint: "/ for the whole Drive, or a folder such as /Documents.",
    fields: [
      {
        id: "clientId",
        label: "Client ID",
        placeholder: "123456789012-abc….apps.googleusercontent.com",
        mono: true,
        hint: "In Google Cloud: enable the Google Drive API, then under Credentials create an OAuth client of type Web application, with this server's /connect/google-drive address as an authorised redirect URI.",
      },
      { id: "clientSecret", label: "Client secret", kind: "secret" },
      { id: "codeVerifier", label: "PKCE verifier", kind: "hidden", required: false },
      {
        id: "code",
        label: "Sign-in code",
        placeholder: "Paste the code shown after you sign in",
        mono: true,
        hint: "Approve in the Google tab; it comes back to a page showing a code. Paste it here. Each code works once.",
        action: { label: "Sign in with Google", run: signInWithGoogle },
        needs: { field: "codeVerifier", message: "Click “Sign in with Google” first." },
      },
    ],
    security: (
      <>
        With Read-only on, jvinu asks Google for read-only access, so Google itself refuses any change; turning it off later means
        connecting again. The client ID and secret are sealed on this server with a refresh token — never your Google password.
        Remove access any time at myaccount.google.com → Security → Third-party apps with account access. Files are served
        through this app rather than as Drive links, and deletes go to the Drive bin. Google Docs, Sheets and Slides open as PDFs.
      </>
    ),
  },

  onedrive: {
    bucketLabel: "Folder",
    bucketPlaceholder: "/",
    bucketDefault: "/",
    bucketHint: "/ for the whole OneDrive, or a folder such as /Documents.",
    fields: [
      {
        id: "clientId",
        label: "Application (client) ID",
        placeholder: "00000000-0000-0000-0000-000000000000",
        mono: true,
        hint: "Register an app in Microsoft Entra → App registrations, turn on “Allow public client flows” under Authentication, then copy its Application (client) ID.",
      },
      {
        id: "tenant",
        label: "Tenant (optional)",
        placeholder: "common",
        mono: true,
        required: false,
        hint: "Empty for an app that allows any Microsoft account. Use consumers for a personal-accounts-only app, or your tenant ID for a single-organisation app.",
      },
      { id: "signIn", label: "Sign-in", kind: "hidden", required: false },
      {
        id: "userCode",
        label: "Sign-in code",
        placeholder: "Appears when you click the button",
        mono: true,
        hint: "Type this code into the Microsoft tab and approve, then click Connect. It lasts 15 minutes.",
        action: { label: "Sign in with Microsoft", run: signInWithMicrosoft },
        needs: { field: "signIn", message: "Click “Sign in with Microsoft” first." },
      },
    ],
    security: (
      <>
        Only the client ID and a refresh token are kept — no password, no secret. Revoke access any time in your Microsoft account
        under Privacy → Apps and services. Files are served through this app rather than as OneDrive links, and deletes go to the
        OneDrive recycle bin.
      </>
    ),
  },

  dropbox: {
    bucketLabel: "Folder",
    bucketPlaceholder: "/",
    bucketDefault: "/",
    bucketHint: "/ for the whole Dropbox, or a folder such as /Photos.",
    fields: [
      {
        id: "appKey",
        label: "App key",
        placeholder: "15 letters and digits",
        mono: true,
        hint: "Create a Scoped-access app in the Dropbox App Console with files.content.read (and .write to upload), then copy its App key.",
      },
      { id: "codeVerifier", label: "PKCE verifier", kind: "hidden", required: false },
      {
        id: "code",
        label: "Access code",
        placeholder: "Paste the code Dropbox shows",
        mono: true,
        hint: "Approve in the Dropbox tab, then paste the code here. Each code works once.",
        action: { label: "Allow access on Dropbox", run: allowDropboxAccess },
        needs: { field: "codeVerifier", message: "Click “Allow access on Dropbox” first." },
      },
    ],
    security: (
      <>
        Only the app key and a refresh token are kept — no password, no secret. Revoke access any time under Dropbox → Settings →
        Connected apps. Files are served through this app rather than as Dropbox links.
      </>
    ),
  },

  r2: {
    bucketLabel: "Bucket name",
    bucketPlaceholder: "my-bucket",
    fields: [
      { id: "accountId", label: "Account ID", placeholder: "32 hex characters", mono: true, hint: "Cloudflare dashboard → R2 → Account details." },
      {
        id: "jurisdiction",
        label: "Jurisdiction",
        kind: "select",
        options: [["", "Default"], ["eu", "European Union"], ["fedramp", "FedRAMP"]],
        required: false,
        hint: "Only if the bucket was created with a jurisdiction restriction.",
      },
      ...s3Keys("Access key ID", "32 hex characters", "Secret access key"),
    ],
    security: scopedKeyNote("R2 → Manage API tokens, with Object Read & Write on this bucket only"),
  },
  wasabi: {
    bucketLabel: "Bucket name",
    bucketPlaceholder: "my-bucket",
    fields: [
      {
        id: "region",
        label: "Region",
        kind: "select",
        options: WASABI_REGIONS.map((region) => [region, region]),
        hint: "The region the bucket was created in.",
      },
      ...s3Keys("Access key", "20 capital letters and digits"),
    ],
    security: scopedKeyNote("Access Keys in the Wasabi console, with a policy limited to this bucket"),
  },
  b2: {
    bucketLabel: "Bucket name",
    bucketPlaceholder: "my-bucket",
    fields: [
      {
        id: "region",
        label: "Region",
        placeholder: "us-west-004",
        mono: true,
        hint: "From the bucket's S3 endpoint: s3.us-west-004.backblazeb2.com → us-west-004.",
      },
      ...s3Keys("Key ID", "005a1b2c3d4e5f60000000001", "Application key"),
    ],
    security: scopedKeyNote("Application Keys, restricted to this bucket"),
  },
  spaces: {
    bucketLabel: "Space name",
    bucketPlaceholder: "my-space",
    fields: [
      { id: "region", label: "Datacenter", kind: "select", options: SPACES_REGIONS },
      ...s3Keys("Access key", "DO00…"),
    ],
    security: scopedKeyNote("API → Spaces Keys, limited to this Space"),
  },
  scaleway: {
    bucketLabel: "Bucket name",
    bucketPlaceholder: "my-bucket",
    fields: [
      { id: "region", label: "Region", kind: "select", options: SCALEWAY_REGIONS, hint: "The region the bucket was created in." },
      ...s3Keys("Access key", "SCW…"),
    ],
    security: scopedKeyNote("IAM → API keys, for an application whose policy allows only Object Storage on this project"),
  },
  storj: {
    bucketLabel: "Bucket name",
    bucketPlaceholder: "my-bucket",
    bucketHint: "Files go through Storj's hosted S3 gateway (gateway.storjshare.io).",
    fields: [...s3Keys("Access key", "28 lowercase letters and digits")],
    security: (
      <>
        In the Storj console, create an access key of type <strong>S3 credentials</strong>, limited to this bucket. Storj encrypts
        every file before it&rsquo;s stored.
      </>
    ),
  },
  minio: {
    bucketLabel: "Bucket name",
    bucketPlaceholder: "my-bucket",
    fields: [
      {
        id: "endpoint",
        label: "Server address",
        placeholder: "https://minio.example.com:9000",
        hint: "The MinIO S3 API (port 9000 by default), not the web console. Use https unless it's on this machine or network.",
        mono: true,
      },
      { id: "region", label: "Region (optional)", placeholder: "us-east-1", mono: true, required: false, hint: "Only if your MinIO sets one." },
      ...s3Keys("Access key", "minio access key"),
    ],
    security: (
      <>
        Make a dedicated user or service account with a policy limited to this bucket, rather than the root {code("minioadmin")}{" "}
        login.
      </>
    ),
  },

  s3: {
    bucketLabel: "Bucket name",
    bucketPlaceholder: "my-bucket",
    fields: [
      { id: "endpoint", label: "Endpoint (optional)", placeholder: "https://s3.amazonaws.com", hint: ENDPOINT_HINT, mono: true, required: false },
      {
        id: "region",
        label: "Region",
        placeholder: "us-east-1",
        hint: "Detected automatically on AWS; used as given for emulators.",
        mono: true,
        required: false,
      },
      { id: "accessKeyId", label: "Access key", placeholder: "AKIAIOSFODNN7EXAMPLE", mono: true },
      { id: "secretAccessKey", label: "Secret key", kind: "secret" },
    ],
    floci: { endpoint: "http://localhost:4566", region: "us-east-1", accessKeyId: "test", secretAccessKey: "test" },
    security: (
      <>
        Use an IAM user limited to this bucket — it needs {code("s3:ListBucket")}, {code("s3:GetObject")} and{" "}
        {code("s3:PutObject")}.
      </>
    ),
  },
  azure: {
    bucketLabel: "Container",
    bucketPlaceholder: "my-container",
    fields: [
      { id: "accountName", label: "Storage account", placeholder: "mystorageaccount", mono: true },
      { id: "accountKey", label: "Account key", kind: "secret", hint: "Storage account → Access keys → key1." },
      {
        id: "endpoint",
        label: "Blob endpoint (optional)",
        placeholder: "https://mystorageaccount.blob.core.windows.net",
        hint: ENDPOINT_HINT,
        mono: true,
        required: false,
      },
    ],
    floci: {
      accountName: "devstoreaccount1",
      accountKey: AZURITE_KEY,
      endpoint: "http://localhost.floci.io:4577/devstoreaccount1",
    },
    flociNote: "Start it with floci az start. The container must already exist.",
    security: <>The account key grants full access to the whole storage account — keep this browser to yourself.</>,
  },
  gcs: {
    bucketLabel: "Bucket name",
    bucketPlaceholder: "my-bucket",
    fields: [
      { id: "endpoint", label: "Endpoint (optional)", placeholder: "https://storage.googleapis.com", hint: ENDPOINT_HINT, mono: true, required: false },
      { id: "projectId", label: "Project ID (optional)", placeholder: "my-project", mono: true, required: false },
      {
        id: "serviceAccountKey",
        label: "Service-account key (JSON)",
        kind: "textarea",
        placeholder: '{ "type": "service_account", "client_email": "…", "private_key": "-----BEGIN PRIVATE KEY-----…" }',
        hint: "Needed for Google Cloud. Emulators run without one, but then links can't be signed.",
        mono: true,
        required: (values) => !values.endpoint?.trim(),
      },
    ],
    floci: { endpoint: "http://localhost:4588", projectId: "", serviceAccountKey: "" },
    flociNote: "Start it with floci gcp start. The bucket must already exist.",
    security: (
      <>
        Only {code("client_email")} and {code("private_key")} are kept from the key file. Grant the service account
        Storage Object Viewer — plus Creator to upload.
      </>
    ),
  },
  oci: {
    bucketLabel: "Bucket name",
    bucketPlaceholder: "my-bucket",
    fields: [
      { id: "namespace", label: "Namespace", placeholder: "axaxnpcrorw5", mono: true, hint: "Tenancy → Object Storage namespace." },
      { id: "region", label: "Region", placeholder: "us-ashburn-1", mono: true },
      { id: "endpoint", label: "Endpoint (optional)", placeholder: "https://objectstorage.us-ashburn-1.oraclecloud.com", hint: ENDPOINT_HINT, mono: true, required: false },
      { id: "tenancy", label: "Tenancy OCID", placeholder: "ocid1.tenancy.oc1..aaaa…", mono: true },
      { id: "user", label: "User OCID", placeholder: "ocid1.user.oc1..aaaa…", mono: true },
      { id: "fingerprint", label: "Key fingerprint", placeholder: "12:34:56:78:9a:bc:de:f0:…", mono: true },
      {
        id: "privateKey",
        label: "API private key (PEM)",
        kind: "textarea",
        placeholder: "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----",
        mono: true,
      },
      { id: "passphrase", label: "Key passphrase (optional)", kind: "secret", required: false },
    ],
    floci: async () => ({
      endpoint: "http://localhost:4599",
      region: "us-ashburn-1",
      namespace: "floci-local",
      tenancy: "ocid1.tenancy.oc1..floci",
      user: "ocid1.user.oc1..floci",
      ...(await throwawayOciKey()),
    }),
    flociNote:
      "Start it with floci oci start. Floci checks no signatures, so a throwaway key is generated here — but it keeps buckets per tenancy: for buckets made with the OCI CLI, use the tenancy from ~/.oci/config.",
    security: <>Links are served through this app rather than as pre-authenticated requests, so nothing is left to revoke.</>,
  },
};

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[12.5px] font-medium text-accent">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[12.5px] text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

const INPUT_CLASS =
  "h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[14.5px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-[3px] focus:ring-accent-ring";

const firstConnectable = PROVIDER_PRESETS.find((preset) => isConnectable(preset.id))?.id ?? "s3";

export function AddProviderDialog({
  open,
  onClose,
  onConnect,
  existingNames,
}: {
  open: boolean;
  onClose: () => void;
  /** Resolves once the provider accepted the credentials; rejects with a message to show. */
  onConnect: (values: ConnectValues) => Promise<void>;
  existingNames: string[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fieldId = useId();
  const [presetId, setPresetId] = useState<ConnectableKind>(firstConnectable as ConnectableKind);
  const [name, setName] = useState(findPreset(firstConnectable)?.name ?? "");
  const [nameEdited, setNameEdited] = useState(false);
  const [bucket, setBucket] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // Safe by default: a new connection only reads until someone turns writes on.
  const [readOnly, setReadOnly] = useState(true);
  const [atRest, setAtRest] = useState(false);
  // jvinu encryption: the passphrase stays in this dialog until it's sent, then is dropped.
  const [encrypt, setEncrypt] = useState(false);
  const [passphrase, setPassphrase] = useState({ value: "", again: "", salt: "", fromRclone: false, shown: false, kept: false });
  const [serverError, setServerError] = useState<string | null>(null);

  const preset = findPreset(presetId) ?? PROVIDER_PRESETS[0];
  const schema = SCHEMAS[presetId];
  const usingEndpoint = Boolean(values.endpoint?.trim());

  // Drive the native dialog so we inherit focus trapping and Esc for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function reset() {
    setPresetId(firstConnectable as ConnectableKind);
    setName(findPreset(firstConnectable)?.name ?? "");
    setNameEdited(false);
    setBucket("");
    setValues({});
    setRevealed({});
    setErrors({});
    setServerError(null);
    setReadOnly(true);
    setAtRest(false);
    setEncrypt(false);
    setPassphrase({ value: "", again: "", salt: "", fromRclone: false, shown: false, kept: false });
  }

  /** Selects start on their first option, so what's sent matches what's shown. */
  function defaultsFor(kind: ConnectableKind): Record<string, string> {
    return Object.fromEntries(
      SCHEMAS[kind].fields.filter((field) => field.kind === "select" && field.options?.length).map((field) => [field.id, field.options![0][0]]),
    );
  }

  function handlePresetChange(nextId: string) {
    if (!isConnectable(nextId)) return;
    setPresetId(nextId);
    // Credentials don't carry across clouds; the bucket name might — but not a Dropbox or OneDrive path.
    setValues(defaultsFor(nextId));
    const fallback = SCHEMAS[nextId].bucketDefault;
    if (fallback !== undefined) setBucket(fallback);
    else if (SCHEMAS[presetId].bucketDefault !== undefined) setBucket("");
    setErrors({});
    setServerError(null);
    if (!nameEdited) setName(findPreset(nextId)?.name ?? "");
  }

  async function fillFlociDefaults() {
    if (!schema.floci) return;
    const defaults = typeof schema.floci === "function" ? await schema.floci() : schema.floci;
    setValues((current) => ({ ...current, ...defaults }));
    if (!nameEdited) setName(`${preset.name} (Floci)`);
    setErrors({});
  }

  const isRequired = (field: FieldSpec) =>
    typeof field.required === "function" ? field.required(values) : field.required !== false;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setServerError(null);

    const next: Record<string, string> = {};
    const trimmed = name.trim();
    if (!trimmed) next.name = "Give the connection a name.";
    else if (existingNames.some((existing) => existing.toLowerCase() === trimmed.toLowerCase()))
      next.name = "A connection with that name already exists.";
    if (!bucket.trim()) next.bucket = `${schema.bucketLabel} is required.`;
    for (const field of schema.fields) {
      if (isRequired(field) && !values[field.id]?.trim()) next[field.id] = `${field.label.replace(/ \(.*\)$/, "")} is required.`;
      else if (field.needs && !values[field.needs.field]?.trim()) next[field.id] = field.needs.message;
    }
    if (values.endpoint?.trim() && !/^https?:\/\/[^\s/?#]+/i.test(values.endpoint.trim()))
      next.endpoint = "Use a full URL, like http://localhost:4566.";
    if (encrypt) {
      if (!passphrase.value) next.passphrase = "Enter a passphrase.";
      else if (!passphrase.fromRclone && passphrase.value.length < MIN_PASSPHRASE)
        next.passphrase = `At least ${MIN_PASSPHRASE} characters — a few unrelated words work well.`;
      else if (passphrase.again !== passphrase.value) next.passphraseAgain = "The two don't match.";
      if (!passphrase.kept) next.passphraseKept = "Confirm you've kept the passphrase somewhere safe.";
    }

    setErrors(next);
    if (Object.keys(next).length) return;

    setSubmitting(true);
    try {
      // The server checks the credentials against the bucket before anything is saved.
      const payload: ConnectValues = { presetId, name: trimmed, bucket: bucket.trim() };
      if (readOnly) payload.readOnly = "true";
      if (atRest && atRestEncryption(presetId) === "optional") payload.providerEncryption = "true";
      if (encrypt) {
        // Exactly as typed, as rclone takes it.
        payload.encrypt = "true";
        payload.passphrase = passphrase.value;
        if (passphrase.fromRclone && passphrase.salt) payload.passphraseSalt = passphrase.salt;
      }
      for (const field of schema.fields) {
        const value = values[field.id];
        if (value?.trim()) payload[field.id] = field.kind === "textarea" ? value.trim() : value.trim();
      }
      await onConnect(payload);
      dialogRef.current?.close();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : "Couldn't connect.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={() => {
        reset();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      aria-labelledby={`${fieldId}-title`}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(500px,calc(100vw-2rem))] overflow-visible rounded-2xl border border-line bg-surface-raised p-0 text-ink shadow-panel backdrop:bg-black/30 backdrop:backdrop-blur-[3px]"
    >
      <form onSubmit={handleSubmit} className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-start gap-3 border-b border-line px-6 py-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <PlusIcon size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`${fieldId}-title`} className="text-[17px] font-semibold tracking-[-0.01em] text-ink">
              Connect a storage provider
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              AWS, Azure, Google, Oracle, Cloudflare R2, Wasabi, Backblaze B2, DigitalOcean, Scaleway, Storj, MinIO, Dropbox, OneDrive or Google Drive.{" "}
              <a href={`${WEBSITE_URL}/guide`} target="_blank" rel="noreferrer" className="font-medium text-accent-strong hover:underline">
                Which one?
              </a>
            </p>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon size={17} />
          </button>
        </header>

        <div className="scroll-quiet min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <Field id={`${fieldId}-preset`} label="Provider">
            <div className="relative">
              <span
                className="pointer-events-none absolute left-3 top-1/2 size-6 -translate-y-1/2 rounded-full"
                style={{ backgroundImage: `linear-gradient(140deg, ${preset.mark.from}, ${preset.mark.to})` }}
              />
              <select
                id={`${fieldId}-preset`}
                value={presetId}
                onChange={(event) => handlePresetChange(event.target.value)}
                className={`${INPUT_CLASS} cursor-pointer appearance-none pl-11 pr-10`}
              >
                {PROVIDER_PRESETS.filter((item) => !item.system).map((item) => (
                  <option key={item.id} value={item.id} disabled={!isConnectable(item.id)}>
                    {isConnectable(item.id) ? item.name : `${item.name} — coming soon`}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            </div>
          </Field>

          {schema.floci ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-line-strong px-3.5 py-2.5">
            <p className="min-w-0 text-[12.5px] text-ink-muted">
              Testing locally? {schema.flociNote ?? "Fill in the emulator's endpoint and keys."}
            </p>
            <button
              type="button"
              onClick={fillFlociDefaults}
              className="spring shrink-0 rounded-full border border-line-strong px-3 py-1.5 text-[12.5px] font-semibold text-accent-strong transition hover:bg-accent-soft active:scale-[0.97]"
            >
              Use Floci defaults
            </button>
          </div>
          ) : null}

          <Field id={`${fieldId}-name`} label="Connection name" hint="How it appears in the sidebar." error={errors.name}>
            <input
              id={`${fieldId}-name`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
              placeholder={preset.name}
              autoComplete="off"
              autoFocus
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? `${fieldId}-name-error` : undefined}
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            id={`${fieldId}-bucket`}
            label={schema.bucketLabel}
            hint={schema.bucketHint ?? (usingEndpoint ? "It must already exist on that service." : undefined)}
            error={errors.bucket}
          >
            <input
              id={`${fieldId}-bucket`}
              value={bucket}
              onChange={(event) => setBucket(event.target.value)}
              placeholder={schema.bucketPlaceholder}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!errors.bucket}
              aria-describedby={errors.bucket ? `${fieldId}-bucket-error` : undefined}
              className={`${INPUT_CLASS} font-mono text-[13.5px]`}
            />
          </Field>

          {schema.fields.map((field) => {
            // S3's region only matters once an endpoint is set; AWS reports its own.
            if (presetId === "s3" && field.id === "region" && !usingEndpoint) return null;
            if (field.kind === "hidden") return null;
            const id = `${fieldId}-${field.id}`;
            const value = values[field.id] ?? "";
            const set = (next: string) => setValues((current) => ({ ...current, [field.id]: next }));
            const common = {
              id,
              value,
              placeholder: field.placeholder,
              autoComplete: "off",
              spellCheck: false,
              "aria-invalid": !!errors[field.id],
              "aria-describedby": errors[field.id] ? `${id}-error` : undefined,
            };
            const action = field.action;
            return (
              <Field key={field.id} id={id} label={field.label} hint={field.hint} error={errors[field.id]}>
                {action ? (
                  <button
                    type="button"
                    onClick={async () => {
                      // The read-only choice decides what some sign-ins ask for (Google Drive).
                      const result = await action.run({ ...values, readOnly: readOnly ? "true" : "" });
                      if (typeof result === "string") {
                        setErrors((current) => ({ ...current, [field.id]: result }));
                        return;
                      }
                      setValues((current) => ({ ...current, ...result }));
                      setErrors((current) => {
                        const rest = { ...current };
                        delete rest[field.id];
                        return rest;
                      });
                    }}
                    className="spring mb-2 inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-[12.5px] font-semibold text-accent-strong transition hover:bg-accent-soft active:scale-[0.97]"
                  >
                    {action.label}
                    <ExternalIcon size={13} />
                  </button>
                ) : null}
                {field.kind === "select" ? (
                  <div className="relative">
                    <select
                      id={id}
                      value={value}
                      onChange={(event) => set(event.target.value)}
                      aria-invalid={!!errors[field.id]}
                      className={`${INPUT_CLASS} cursor-pointer appearance-none pr-10`}
                    >
                      {field.options?.map(([optionValue, optionLabel]) => (
                        <option key={optionValue} value={optionValue}>
                          {optionLabel}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={16} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-faint" />
                  </div>
                ) : field.kind === "textarea" ? (
                  <textarea
                    {...common}
                    rows={5}
                    onChange={(event) => set(event.target.value)}
                    className={`${INPUT_CLASS} h-auto resize-y py-2.5 font-mono text-[12px] leading-relaxed`}
                  />
                ) : field.kind === "secret" ? (
                  <div className="relative">
                    <input
                      {...common}
                      type={revealed[field.id] ? "text" : "password"}
                      onChange={(event) => set(event.target.value)}
                      className={`${INPUT_CLASS} pr-20 font-mono text-[13.5px]`}
                    />
                    <button
                      type="button"
                      onClick={() => setRevealed((current) => ({ ...current, [field.id]: !current[field.id] }))}
                      aria-pressed={Boolean(revealed[field.id])}
                      aria-label={`${revealed[field.id] ? "Hide" : "Show"} ${field.label.toLowerCase()}`}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
                    >
                      {revealed[field.id] ? "Hide" : "Show"}
                    </button>
                  </div>
                ) : (
                  <input
                    {...common}
                    onChange={(event) => set(event.target.value)}
                    inputMode={field.id === "endpoint" ? "url" : undefined}
                    className={`${INPUT_CLASS} ${field.mono ? "font-mono text-[13.5px]" : ""}`}
                  />
                )}
              </Field>
            );
          })}

          {atRestEncryption(presetId) === "optional" ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-3.5 py-3">
              <input
                type="checkbox"
                checked={atRest}
                onChange={(event) => setAtRest(event.target.checked)}
                className="mt-0.5 size-4 cursor-pointer accent-[var(--accent-fill)]"
              />
              <span>
                <span className="block text-[13.5px] font-medium text-ink">Encrypt new files at rest</span>
                <span className="block text-[12.5px] text-ink-muted">
                  Asks {presetId === "b2" ? "Backblaze (SSE-B2)" : "the service (SSE-S3)"} to encrypt everything jvinu uploads or copies, with
                  keys it manages. {presetId === "s3" ? "On AWS this is already the default; other S3 services must support SSE-S3." : ""}
                </span>
              </span>
            </label>
          ) : atRestEncryption(presetId) === "always" ? (
            <p className="flex items-start gap-2.5 rounded-xl bg-surface-sunken px-3.5 py-3 text-[12.5px] text-ink-muted">
              <LockIcon size={15} className="mt-0.5 shrink-0 text-ink-faint" />
              <span>{preset.name} encrypts everything at rest, always — there&rsquo;s nothing to switch on.</span>
            </p>
          ) : null}

          <div className="rounded-xl border border-line px-3.5 py-3">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={encrypt}
                onChange={(event) => setEncrypt(event.target.checked)}
                className="mt-0.5 size-4 cursor-pointer accent-[var(--accent-fill)]"
              />
              <span>
                <span className="block text-[13.5px] font-medium text-ink">Encrypt files with a passphrase</span>
                <span className="block text-[12.5px] text-ink-muted">
                  jvinu encrypts each file before it leaves this server, so {preset.name} only ever stores ciphertext. The format is
                  rclone&rsquo;s crypt, so rclone can read the files too.
                </span>
              </span>
            </label>

            {encrypt ? (
              <div className="pop-in mt-3.5 space-y-3.5 border-t border-line pt-3.5">
                <Field
                  id={`${fieldId}-passphrase`}
                  label="Passphrase"
                  hint={passphrase.fromRclone ? "The password from your rclone crypt remote." : `At least ${MIN_PASSPHRASE} characters. A few unrelated words work well.`}
                  error={errors.passphrase}
                >
                  <div className="relative">
                    <input
                      id={`${fieldId}-passphrase`}
                      type={passphrase.shown ? "text" : "password"}
                      value={passphrase.value}
                      onChange={(event) => setPassphrase((current) => ({ ...current, value: event.target.value }))}
                      autoComplete="new-password"
                      spellCheck={false}
                      aria-invalid={!!errors.passphrase}
                      aria-describedby={errors.passphrase ? `${fieldId}-passphrase-error` : undefined}
                      className={`${INPUT_CLASS} pr-20 font-mono text-[13.5px]`}
                    />
                    <button
                      type="button"
                      onClick={() => setPassphrase((current) => ({ ...current, shown: !current.shown }))}
                      aria-pressed={passphrase.shown}
                      aria-label={`${passphrase.shown ? "Hide" : "Show"} passphrase`}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
                    >
                      {passphrase.shown ? "Hide" : "Show"}
                    </button>
                  </div>
                </Field>
                <Field id={`${fieldId}-passphrase-again`} label="Type it again" error={errors.passphraseAgain}>
                  <input
                    id={`${fieldId}-passphrase-again`}
                    type={passphrase.shown ? "text" : "password"}
                    value={passphrase.again}
                    onChange={(event) => setPassphrase((current) => ({ ...current, again: event.target.value }))}
                    autoComplete="new-password"
                    spellCheck={false}
                    aria-invalid={!!errors.passphraseAgain}
                    aria-describedby={errors.passphraseAgain ? `${fieldId}-passphrase-again-error` : undefined}
                    className={`${INPUT_CLASS} font-mono text-[13.5px]`}
                  />
                </Field>

                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={passphrase.fromRclone}
                    onChange={(event) => setPassphrase((current) => ({ ...current, fromRclone: event.target.checked }))}
                    className="mt-0.5 size-4 cursor-pointer accent-[var(--accent-fill)]"
                  />
                  <span className="text-[12.5px] text-ink-muted">
                    <span className="font-medium text-ink">rclone already encrypts this {schema.bucketLabel.replace(/ name$/, "").toLowerCase()}.</span>{" "}
                    Its file names must be left unencrypted (<code className="font-mono text-[11.5px]">filename_encryption = off</code>).
                  </span>
                </label>
                {passphrase.fromRclone ? (
                  <Field
                    id={`${fieldId}-passphrase-salt`}
                    label="Salt (rclone’s password2)"
                    hint="Only if you set one in rclone. Leave it empty otherwise."
                  >
                    <input
                      id={`${fieldId}-passphrase-salt`}
                      type={passphrase.shown ? "text" : "password"}
                      value={passphrase.salt}
                      onChange={(event) => setPassphrase((current) => ({ ...current, salt: event.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      className={`${INPUT_CLASS} font-mono text-[13.5px]`}
                    />
                  </Field>
                ) : null}

                <div className="rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink">
                  <p className="font-semibold">Lose the passphrase, lose the files.</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 text-ink-muted">
                    <li>
                      Nobody can reset it — not jvinu, not {preset.name}. This server keeps a sealed copy of the key, but if its data or
                      JVINU_SECRET is lost, the passphrase is the only way back in (here or with rclone).
                    </li>
                    <li>File and folder names stay readable; only what&rsquo;s inside the files is encrypted.</li>
                    <li>There are no direct links: previews, downloads and shares are all served through jvinu.</li>
                    <li>It&rsquo;s set for good: the passphrase can&rsquo;t be changed, and encryption can&rsquo;t be turned off later.</li>
                  </ul>
                  <label className="mt-2.5 flex cursor-pointer items-start gap-2.5 font-medium">
                    <input
                      type="checkbox"
                      checked={passphrase.kept}
                      onChange={(event) => setPassphrase((current) => ({ ...current, kept: event.target.checked }))}
                      aria-invalid={!!errors.passphraseKept}
                      aria-describedby={errors.passphraseKept ? `${fieldId}-passphrase-kept-error` : undefined}
                      className="mt-0.5 size-4 cursor-pointer accent-[var(--accent-fill)]"
                    />
                    I&rsquo;ve stored the passphrase somewhere safe, and I understand it can&rsquo;t be recovered.
                  </label>
                  {errors.passphraseKept ? (
                    <p id={`${fieldId}-passphrase-kept-error`} className="mt-1.5 font-medium text-accent">
                      {errors.passphraseKept}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-3.5 py-3">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(event) => {
                setReadOnly(event.target.checked);
                // A Google sign-in was for read-only or full access: a changed choice needs a new one.
                if (presetId === "gdrive" && values.codeVerifier) setValues((current) => ({ ...current, codeVerifier: "", code: "" }));
              }}
              className="mt-0.5 size-4 cursor-pointer accent-[var(--accent-fill)]"
            />
            <span>
              <span className="block text-[13.5px] font-medium text-ink">Read-only</span>
              <span className="block text-[12.5px] text-ink-muted">
                On by default: browse, preview and download only — the server refuses uploads, renames, moves and deletes.
                Untick to make changes; you can switch it later in the connection&rsquo;s settings.
              </span>
            </span>
          </label>

          {serverError ? (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[13px] font-medium text-ink">
              {serverError}
            </p>
          ) : null}

          <p className="flex items-start gap-2.5 rounded-xl bg-surface-sunken px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-muted">
            <LockIcon size={15} className="mt-0.5 shrink-0 text-ink-faint" />
            <span>
              Credentials are checked against the {schema.bucketLabel.replace(/ name$/, "").toLowerCase()} first, then stored encrypted
              (AES-256-GCM) on the server under its master key. They are never sent back to the page.{" "}
              {schema.security}
            </span>
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="rounded-xl border border-line-strong bg-surface px-4 py-2.5 text-[14px] font-semibold text-ink transition hover:bg-surface-sunken active:scale-[0.99]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="spring inline-flex items-center gap-2 rounded-xl bg-accent-fill px-4 py-2.5 text-[14px] font-semibold text-white transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-wait disabled:opacity-70"
          >
            <CheckIcon size={16} />
            {submitting ? "Verifying…" : "Connect"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
