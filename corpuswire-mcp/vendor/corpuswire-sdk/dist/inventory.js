const encoder = new TextEncoder();
export const INVENTORY_VERSION = "workspace-inventory/v1";
// Keep in sync with corpuswire.ingest.capabilities.CODE_EXTENSIONS.
const CODE_EXTENSIONS = new Set([".bat", ".scala", ".sh", ".cjs", ".js", ".jsx", ".mjs", ".cts", ".mts", ".ts", ".tsx", ".java", ".kt", ".kts", ".py", ".pyi", ".hcl", ".tf", ".html", ".htm", ".c", ".cc", ".cpp", ".cs", ".cxx", ".go", ".h", ".hh", ".hpp", ".hxx", ".php", ".rb", ".rs", ".sql", ".swift"]);
// Keep in sync with corpuswire.ingest.capabilities.SUPPORTED_FILENAME_TYPES and
// SUPPORTED_FILENAME_PREFIX_TYPES: the server's code checkpoint counts these as code,
// so uploading them in a later tier makes the checkpoint fail with 409.
const CODE_FILENAMES = new Set(["gradlew", "mvnw", "dockerfile"]);
// IDX-004: build manifests scheduled with documentation when the server indexes build files.
// Manifests with a code extension (build.gradle.kts, settings.gradle.kts, setup.py) stay in the
// code tier because the server's code checkpoint counts them as code regardless of the flag.
const BUILD_MANIFEST_FILENAMES = new Set(["build.gradle", "package.json", "pom.xml", "pyproject.toml", "settings.gradle"]);
/** Scheduling tiers match the server's canonical supported-file registry. */
export function ingestionPriority(relativePath, fileTypes) {
    const name = relativePath.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
    const extension = name.slice(name.lastIndexOf("."));
    if (CODE_EXTENSIONS.has(extension) || CODE_FILENAMES.has(name) || name.endsWith(".tf.json")
        || (name.startsWith("dockerfile.") && name.length > "dockerfile.".length))
        return 1;
    if ([".md", ".txt", ".pdf"].includes(extension))
        return 2;
    if (fileTypes?.buildFilesEnabled === true && BUILD_MANIFEST_FILENAMES.has(name))
        return 2;
    return 3;
}
export class WorkspaceScanIncompleteError extends Error {
    code = "scan_incomplete";
    sessionId;
    manifestErrors;
    manifestSkipped;
    constructor(message = "Workspace scan did not complete", details = {}) {
        super(message);
        this.name = "WorkspaceScanIncompleteError";
        this.sessionId = details.sessionId;
        this.manifestErrors = Object.freeze([...(details.manifestErrors ?? [])]);
        this.manifestSkipped = details.manifestSkipped;
    }
}
export function canonicalInventoryPath(value) {
    const path = value.replaceAll("\\", "/");
    if (!path || path.trim() !== path || path.startsWith("/") || /^[A-Za-z]:/.test(path)
        || path.includes("\0") || path.split("/").some((part) => ["", ".", ".."].includes(part))
        || /[\uD800-\uDFFF]/u.test(path)) {
        throw new WorkspaceScanIncompleteError("Inventory requires safe relative paths and valid Unicode");
    }
    return path;
}
function compareUtf8(left, right) {
    const a = encoder.encode(left), b = encoder.encode(right);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
        if (a[i] !== b[i])
            return a[i] - b[i];
    }
    return a.length - b.length;
}
export async function inventorySha256(content) {
    const bytes = typeof content === "string" ? encoder.encode(content) : new Uint8Array(content);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function inventoryDigest(entries) {
    const seen = new Set();
    const normalized = entries.map(([rawPath, hash, size]) => {
        const path = canonicalInventoryPath(rawPath);
        if (seen.has(path) || !/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0) {
            throw new WorkspaceScanIncompleteError("Inventory requires unique paths, lowercase SHA-256 and safe sizes");
        }
        seen.add(path);
        return [path, hash, size];
    }).sort((a, b) => compareUtf8(a[0], b[0]));
    return inventorySha256(JSON.stringify(normalized));
}
export async function selectionPolicyDigest(policy) {
    const canonical = { ...policy,
        include_globs: [...new Set(policy.include_globs)].sort(compareUtf8),
        exclude_globs: [...new Set(policy.exclude_globs)].sort(compareUtf8),
    };
    return inventorySha256(JSON.stringify(canonical, Object.keys(canonical).sort()));
}
export async function buildWorkspaceInventory(entries, policy, scan) {
    if (scan.complete !== true || !Number.isSafeInteger(scan.excludedFileCount) || scan.excludedFileCount < 0
        || !Number.isFinite(Date.parse(scan.startedAt)) || !Number.isFinite(Date.parse(scan.completedAt))
        || Date.parse(scan.startedAt) > Date.parse(scan.completedAt)) {
        throw new WorkspaceScanIncompleteError();
    }
    const bytes = entries.reduce((sum, entry) => sum + entry[2], 0);
    if (!Number.isSafeInteger(bytes))
        throw new WorkspaceScanIncompleteError("Inventory byte count overflow");
    return {
        schema_version: INVENTORY_VERSION, scan_complete: true, selection_policy: policy,
        selection_policy_digest: await selectionPolicyDigest(policy), manifest_digest: await inventoryDigest(entries),
        eligible_file_count: entries.length, eligible_source_bytes: bytes, excluded_file_count: scan.excludedFileCount,
        scan_started_at: scan.startedAt, scan_completed_at: scan.completedAt,
    };
}
const DISCOVERY_ONLY_FILENAMES = new Set([".terraform.lock.hcl", "angular.json", "build.gradle", "build.gradle.kts", "bun.lock", "bun.lockb", "dependencies.lock", "gradle.lockfile", "gradle.properties", "jsconfig.json", "libs.versions.toml", "npm-shrinkwrap.json", "nx.json", "package-lock.json", "package.json", "pdm.lock", "pipfile", "pipfile.lock", "pnpm-lock.yaml", "poetry.lock", "pom.xml", "project.json", "pyproject.toml", "settings.gradle", "settings.gradle.kts", "setup.cfg", "setup.py", "uv.lock", "workspace.json", "yarn.lock"]);
/** CorpusWire clients write failure diagnostics here; the retriever never serves them. */
function isRetrievalDiagnosticPath(parts) {
    const directories = parts.slice(0, -1);
    return directories.some((part, index) => part === "reports" && directories[index + 1] === "retrieval-failures");
}
// IDX-004: file names that are excluded even when the server indexes build files. The server's
// discovery_only_filenames lists the same set; this local copy keeps them out if it is incomplete.
const BUILD_EXCLUDED_FILENAMES = new Set([".terraform.lock.hcl", "bun.lock", "bun.lockb", "dependencies.lock", "gradle.lockfile", "npm-shrinkwrap.json", "package-lock.json", "pdm.lock", "pipfile.lock", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "yarn.lock", "settings.xml", "settings-security.xml"]);
const BUILD_FILENAMES = new Set(["angular.json", "build.gradle", "build.gradle.kts", "gradle.properties", "jsconfig.json", "libs.versions.toml", "nx.json", "package.json", "pipfile", "pom.xml", "project.json", "pyproject.toml", "settings.gradle", "settings.gradle.kts", "setup.cfg", "setup.py", "workspace.json"]);
function lowercaseStrings(values) {
    return Array.isArray(values)
        ? values.filter((value) => typeof value === "string" && value.length > 0).map((value) => value.toLowerCase())
        : [];
}
/** Derive the retrieval file-type policy from server capabilities; missing fields mean build files are off. */
export function retrievalFileTypesFromCapabilities(capabilities) {
    return {
        buildFilesEnabled: capabilities?.build_files_enabled === true,
        discoveryOnlyFilenames: new Set(lowercaseStrings(capabilities?.discovery_only_filenames)),
        discoveryOnlyExtensions: lowercaseStrings(capabilities?.discovery_only_extensions),
        pipelineFilesEnabled: capabilities?.pipeline_files_enabled === true,
    };
}
// IDX-005: keep in sync with the engine's pipeline-file allow-list (INDEX_PIPELINE_FILES).
// Case-sensitive, workspace-relative POSIX paths ending in .yml or .yaml.
const PIPELINE_DOT_PATH = /^(?:\.github\/workflows\/[^/]+|\.github\/actions\/(?:.+\/)?action|\.gitlab-ci|\.gitlab\/ci\/.+|\.circleci\/config|\.buildkite\/.+|\.azure-pipelines(?:\/.+)?|\.drone|\.travis|\.woodpecker(?:\/.+)?|\.tekton\/.+)\.ya?ml$/;
// Dot directories whose whole subtree (without further dot segments) can hold allowed files.
const PIPELINE_DOT_SUBTREES = [".github/actions", ".gitlab/ci", ".buildkite", ".azure-pipelines", ".woodpecker", ".tekton"];
// Dot directories that can hold allowed files only directly, or only through a listed child.
const PIPELINE_DOT_DIRECTORIES = new Set([".github", ".github/workflows", ".gitlab", ".circleci"]);
/**
 * True when a CI pipeline definition under a dot path is on the IDX-005 allow-list. Clients that
 * skip hidden paths admit these only when the server reports `pipeline_files_enabled: true`.
 */
export function isPipelineDotPath(relativePath) {
    return PIPELINE_DOT_PATH.test(relativePath)
        && !relativePath.split("/").slice(1).some((segment) => segment.startsWith("."));
}
/**
 * True when a workspace-relative directory can contain a path accepted by {@link isPipelineDotPath},
 * so directory walkers know which hidden directories to descend into.
 */
export function isPipelineDotPathAncestor(relativeDirectory) {
    const normalized = relativeDirectory.replace(/\/+$/, "");
    if (normalized.split("/").slice(1).some((segment) => segment.startsWith(".") || segment.length === 0))
        return false;
    return PIPELINE_DOT_DIRECTORIES.has(normalized)
        || PIPELINE_DOT_SUBTREES.some((subtree) => normalized === subtree || normalized.startsWith(`${subtree}/`));
}
function isBuildTierName(name) {
    return BUILD_FILENAMES.has(name)
        || /\.(gradle|properties|xml)$/.test(name)
        || (name.startsWith("tsconfig") && name.endsWith(".json"))
        || /^(requirements|constraints)([-_].*)?\.txt$/.test(name);
}
function isSensitiveTerraformName(name) {
    return name.endsWith(".tfvars") || name.endsWith(".tfvars.json") || name.includes(".tfstate")
        || name === "crash.log" || name === "tfplan"
        || /\.(tfplan|plan)(\.json)?$/.test(name);
}
/**
 * Exclude raw discovery metadata, Terraform values and CorpusWire's own diagnostics from source uploads.
 * Without `fileTypes`, or when the server does not index build files, the built-in floor applies.
 */
export function isRetrievalExcludedPath(relativePath, fileTypes) {
    const parts = relativePath.replaceAll("\\", "/").toLowerCase().split("/");
    const name = parts.at(-1);
    if (fileTypes?.buildFilesEnabled === true) {
        return isRetrievalDiagnosticPath(parts)
            || isSensitiveTerraformName(name)
            || BUILD_EXCLUDED_FILENAMES.has(name)
            || fileTypes.discoveryOnlyFilenames.has(name)
            || fileTypes.discoveryOnlyExtensions.some((extension) => name.endsWith(extension))
            || (isBuildTierName(name) && /secret|credential|password/.test(name));
    }
    return isRetrievalDiagnosticPath(parts)
        || DISCOVERY_ONLY_FILENAMES.has(name)
        || /\.(gradle|properties|tfvars|xml)$/.test(name)
        || (name.startsWith("tsconfig") && name.endsWith(".json"))
        || /^(requirements|constraints)([-_].*)?\.txt$/.test(name)
        || name.endsWith(".tfvars.json") || name.includes(".tfstate")
        || name === "crash.log" || name === "tfplan"
        || /\.(tfplan|plan)(\.json)?$/.test(name);
}
