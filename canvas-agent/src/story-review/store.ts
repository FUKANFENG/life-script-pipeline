import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ReviewStatus = "pending" | "approved" | "needs_changes";
export type VersionSource = "original" | "generated" | "uploaded";

type ShotVersion = {
    id: string;
    createdAt: string;
    source: VersionSource;
    file: string;
    mimeType: string;
    width: number;
    height: number;
    sha256: string;
    prompt?: string;
    model?: string;
    note?: string;
    parentVersionId?: string;
    referenceIds?: string[];
};

type ShotCustomReference = {
    id: string;
    createdAt: string;
    label: string;
    file: string;
    mimeType: string;
    width: number;
    height: number;
    sha256: string;
    active: boolean;
};

type ReviewShot = {
    id: string;
    index: number;
    chapterId: string;
    sceneId: string;
    locationId: string;
    characterIds: string[];
    function: string;
    visual: string;
    composition: string;
    prompt: string;
    narration: {
        vo: string;
        sourceExcerpt: string;
        startSample: number;
        endSample: number;
        startSeconds: number;
        endSeconds: number;
        durationSeconds: number;
        startFrame: number;
        endFrame: number;
    };
    reviewStatus: ReviewStatus;
    reviewNote: string;
    selectedVersionId: string;
    versions: ShotVersion[];
    customReferences?: ShotCustomReference[];
};

type ReviewProject = {
    schemaVersion: "1.0";
    id: string;
    canvasProjectId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    timeline: { fps: number; sampleRate: number; totalFrames: number; totalSamples: number; totalSeconds: number };
    delivery: { audioFile: string; subtitleFile: string; sourceVideoFile?: string };
    style: { description: string; referenceFile?: string };
    assetBible: { characters: Array<Record<string, unknown>>; locations: Array<Record<string, unknown>>; props: Array<Record<string, unknown>> };
    shots: ReviewShot[];
};

type ExportJob = {
    id: string;
    projectId: string;
    status: "running" | "succeeded" | "failed";
    createdAt: string;
    finishedAt?: string;
    progress: number;
    currentShot?: string;
    error?: string;
};

type ProjectLocation = { root: string; stateFile: string };

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export class StoryReviewStore {
    readonly workspacePath: string;
    private readonly locations = new Map<string, ProjectLocation>();
    private readonly mutations = new Map<string, Promise<unknown>>();
    private readonly jobs = new Map<string, ExportJob>();

    constructor(workspacePath: string) {
        const candidates = [process.env.INFINITE_CANVAS_WORKSPACE, workspacePath, process.cwd(), path.resolve(process.cwd(), "..")]
            .filter((item): item is string => Boolean(item))
            .map((item) => path.resolve(item));
        this.workspacePath = candidates.find((item) => existsSync(path.join(item, "outputs"))) || candidates[0];
    }

    async project(projectId: string) {
        const location = await this.locate(projectId);
        const project = await this.loadOrImport(location, projectId);
        return this.publicProject(project, location.root);
    }

    async image(projectId: string, shotId: string, versionId: string) {
        const { root, project } = await this.load(projectId);
        const shot = requiredShot(project, shotId);
        const version = shot.versions.find((item) => item.id === versionId);
        if (!version) throw new Error(`镜头 ${shotId} 不存在版本 ${versionId}`);
        return safeProjectFile(root, version.file);
    }

    async referenceImage(projectId: string, referenceId: string) {
        const { root, project } = await this.load(projectId);
        if (referenceId === "style") {
            if (!project.style.referenceFile) throw new Error("项目没有风格参考图");
            return safeProjectFile(root, project.style.referenceFile);
        }
        const assetMatch = referenceId.match(/^asset:(character|location):(.+)$/);
        if (assetMatch) {
            const collection = assetMatch[1] === "character" ? project.assetBible.characters : project.assetBible.locations;
            const asset = collection.find((item) => String(item.id || "") === assetMatch[2]);
            const referenceFile = String(asset?.referenceFile || asset?.reference_file || "");
            if (!asset || !referenceFile) throw new Error(`项目没有参考素材 ${referenceId}`);
            return safeProjectFile(root, referenceFile);
        }
        const match = referenceId.match(/^shot:(S\d+)$/i);
        if (!match) throw new Error("参考图标识无效");
        const shot = requiredShot(project, match[1].toUpperCase());
        const version = shot.versions.find((item) => item.id === shot.selectedVersionId);
        if (!version) throw new Error(`镜头 ${shot.id} 的当前版本无效`);
        return safeProjectFile(root, version.file);
    }

    async customReferenceImage(projectId: string, shotId: string, referenceId: string) {
        const { root, project } = await this.load(projectId);
        const shot = requiredShot(project, shotId);
        const reference = (shot.customReferences || []).find((item) => item.id === referenceId);
        if (!reference) throw new Error(`镜头 ${shotId} 不存在参考图 ${referenceId}`);
        return safeProjectFile(root, reference.file);
    }

    async addCustomReference(projectId: string, shotId: string, input: Record<string, unknown>) {
        return this.mutate(projectId, async (project, root) => {
            const shot = requiredShot(project, shotId);
            const { bytes, mimeType, extension } = decodeImageDataUrl(input.dataUrl);
            const label = String(input.label || "").trim().slice(0, 100);
            if (!label) throw new Error("请说明参考图对应的人物或对象");
            const references = shot.customReferences || (shot.customReferences = []);
            if (references.filter((item) => item.active).length >= 4) throw new Error("单个镜头最多启用 4 张用户参考图");
            const referenceId = nextReferenceId(references);
            const relativeFile = posixPath(path.join("review", "references", shot.id, `${referenceId}${extension}`));
            const target = safeProjectFile(root, relativeFile);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, bytes);
            const reference: ShotCustomReference = {
                id: referenceId,
                createdAt: new Date().toISOString(),
                label,
                file: relativeFile,
                mimeType,
                width: positiveInteger(input.width, 1),
                height: positiveInteger(input.height, 1),
                sha256: sha256(bytes),
                active: true,
            };
            references.push(reference);
            return reference;
        });
    }

    async removeCustomReference(projectId: string, shotId: string, referenceId: string) {
        return this.mutate(projectId, async (project) => {
            const shot = requiredShot(project, shotId);
            const reference = (shot.customReferences || []).find((item) => item.id === referenceId);
            if (!reference) throw new Error(`镜头 ${shotId} 不存在参考图 ${referenceId}`);
            reference.active = false;
            return reference;
        });
    }

    async addVersion(projectId: string, shotId: string, input: Record<string, unknown>) {
        return this.mutate(projectId, async (project, root) => {
            const shot = requiredShot(project, shotId);
            const { bytes, mimeType, extension } = decodeImageDataUrl(input.dataUrl);
            const source = input.source === "uploaded" ? "uploaded" : "generated";
            const referenceIds = Array.isArray(input.referenceIds)
                ? Array.from(new Set(input.referenceIds.map(String))).filter(Boolean).slice(0, 6)
                : [];
            const knownReferenceIds = new Set((shot.customReferences || []).map((item) => item.id));
            const unknownReference = referenceIds.find((id) => !knownReferenceIds.has(id));
            if (unknownReference) throw new Error(`镜头 ${shotId} 不存在参考图 ${unknownReference}`);
            const versionId = nextVersionId(shot.versions);
            const relativeFile = posixPath(path.join("review", "versions", shot.id, `${versionId}${extension}`));
            const target = safeProjectFile(root, relativeFile);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, bytes);
            const version: ShotVersion = {
                id: versionId,
                createdAt: new Date().toISOString(),
                source,
                file: relativeFile,
                mimeType,
                width: positiveInteger(input.width, 16),
                height: positiveInteger(input.height, 9),
                sha256: sha256(bytes),
                prompt: optionalString(input.prompt),
                model: optionalString(input.model),
                note: optionalString(input.note),
                parentVersionId: shot.selectedVersionId,
                ...(referenceIds.length ? { referenceIds } : {}),
            };
            shot.versions.push(version);
            if (input.select !== false) shot.selectedVersionId = versionId;
            shot.reviewStatus = "needs_changes";
            return version;
        });
    }

    async selectVersion(projectId: string, shotId: string, versionId: string) {
        return this.mutate(projectId, async (project) => {
            const shot = requiredShot(project, shotId);
            if (!shot.versions.some((item) => item.id === versionId)) throw new Error(`镜头 ${shotId} 不存在版本 ${versionId}`);
            shot.selectedVersionId = versionId;
            shot.reviewStatus = "pending";
            return shot;
        });
    }

    async reviewShot(projectId: string, shotId: string, input: Record<string, unknown>) {
        return this.mutate(projectId, async (project) => {
            const shot = requiredShot(project, shotId);
            const status = String(input.status || "");
            if (!(["pending", "approved", "needs_changes"] as const).includes(status as ReviewStatus)) throw new Error("审核状态无效");
            shot.reviewStatus = status as ReviewStatus;
            if (typeof input.note === "string") shot.reviewNote = input.note.trim().slice(0, 2000);
            return shot;
        });
    }

    async startExport(projectId: string) {
        const { root } = await this.load(projectId);
        if (Array.from(this.jobs.values()).some((job) => job.projectId === projectId && job.status === "running")) throw new Error("当前项目已有导出任务正在运行");
        const exportId = `export-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
        const job: ExportJob = { id: exportId, projectId, status: "running", createdAt: new Date().toISOString(), progress: 0 };
        this.jobs.set(exportId, job);
        const renderer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "render-story-review.py");
        const command = process.env.PYTHON || "python";
        const child = spawn(command, [renderer, "--project-root", root, "--export-id", exportId], { cwd: this.workspacePath, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let errorText = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            for (const line of chunk.split(/\r?\n/)) {
                try {
                    const event = JSON.parse(line) as { type?: string; completed?: number; total?: number; shotId?: string };
                    if (event.type === "progress" && event.total) {
                        job.progress = Math.max(0, Math.min(1, Number(event.completed || 0) / event.total));
                        job.currentShot = event.shotId;
                    }
                } catch {}
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            errorText = `${errorText}${chunk}`.slice(-8000);
        });
        child.once("error", (error) => {
            job.status = "failed";
            job.finishedAt = new Date().toISOString();
            job.error = error.message;
        });
        child.once("exit", (code) => {
            job.status = code === 0 ? "succeeded" : "failed";
            job.progress = code === 0 ? 1 : job.progress;
            job.finishedAt = new Date().toISOString();
            if (code !== 0) job.error = errorText.trim() || `渲染进程退出码 ${code}`;
        });
        return job;
    }

    exportJob(projectId: string, exportId: string) {
        const job = this.jobs.get(exportId);
        if (!job || job.projectId !== projectId) throw new Error("导出任务不存在或服务已重启，请查看已完成导出");
        return job;
    }

    async exportFile(projectId: string, exportId: string, kind: string) {
        const { root } = await this.load(projectId);
        const receipt = JSON.parse(await readFile(safeProjectFile(root, path.join("review", "exports", exportId, "receipt.json")), "utf8")) as { files?: Record<string, { path?: string }> };
        const file = receipt.files?.[kind]?.path;
        if (!file) throw new Error("导出文件不存在");
        return safeProjectFile(root, file);
    }

    async exportDirectory(projectId: string, exportId: string) {
        const { root } = await this.load(projectId);
        const directory = safeProjectFile(root, path.join("review", "exports", exportId));
        const info = await stat(directory);
        if (!info.isDirectory()) throw new Error("导出目录不存在");
        return directory;
    }

    private async load(projectId: string) {
        const location = await this.locate(projectId);
        return { root: location.root, project: await this.loadOrImport(location, projectId) };
    }

    private async locate(projectId: string): Promise<ProjectLocation> {
        const safeId = validateId(projectId);
        const cached = this.locations.get(safeId);
        if (cached) return cached;
        const outputs = path.join(this.workspacePath, "outputs");
        const entries = await readdir(outputs, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const root = path.join(outputs, entry.name);
            const mediaPath = path.join(root, "media-export-manifest.json");
            const shotPath = path.join(root, "shot_manifest.json");
            try {
                await Promise.all([access(mediaPath), access(shotPath)]);
                const media = JSON.parse(await readFile(mediaPath, "utf8")) as { project_id?: string };
                if (media.project_id !== safeId && entry.name !== safeId) continue;
                const location = { root, stateFile: path.join(root, "review", "review-project.json") };
                this.locations.set(safeId, location);
                return location;
            } catch {}
        }
        throw new Error(`没有找到画布 ${safeId} 对应的镜头项目`);
    }

    private async loadOrImport(location: ProjectLocation, projectId: string): Promise<ReviewProject> {
        try {
            return JSON.parse(await readFile(location.stateFile, "utf8")) as ReviewProject;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const project = await importProject(location.root, projectId);
            await persistProject(location.stateFile, project);
            return project;
        }
    }

    private async mutate<T>(projectId: string, action: (project: ReviewProject, root: string) => Promise<T>) {
        const previous = this.mutations.get(projectId) || Promise.resolve();
        let resolveQueue!: () => void;
        const current = new Promise<void>((resolve) => (resolveQueue = resolve));
        const queued = previous.then(() => current);
        this.mutations.set(projectId, queued);
        await previous;
        try {
            const location = await this.locate(projectId);
            const project = await this.loadOrImport(location, projectId);
            const result = await action(project, location.root);
            project.updatedAt = new Date().toISOString();
            await persistProject(location.stateFile, project);
            return { ok: true, result, project: await this.publicProject(project, location.root) };
        } finally {
            resolveQueue();
            if (this.mutations.get(projectId) === queued) this.mutations.delete(projectId);
        }
    }

    private async publicProject(project: ReviewProject, root: string) {
        const sceneFirst = new Map<string, ReviewShot>();
        project.shots.forEach((shot) => {
            const referenceKey = shot.locationId || shot.sceneId;
            if (!sceneFirst.has(referenceKey)) sceneFirst.set(referenceKey, shot);
        });
        const shots = project.shots.map((shot, index) => {
            const imageReferences: Array<{ id: string; role: string; label: string }> = [];
            if (project.style.referenceFile) imageReferences.push({ id: "style", role: "style", label: "统一画风母版" });
            for (const characterId of shot.characterIds || []) {
                const character = project.assetBible.characters.find((item) => String(item.id || "") === characterId);
                if (character && (character.referenceFile || character.reference_file)) {
                    imageReferences.push({ id: `asset:character:${characterId}`, role: "identity", label: String(character.name || character.label || characterId) });
                }
            }
            const location = project.assetBible.locations.find((item) => String(item.id || "") === (shot.locationId || shot.sceneId));
            const referenceKey = shot.locationId || shot.sceneId;
            const anchor = sceneFirst.get(referenceKey);
            if (location && (location.referenceFile || location.reference_file)) {
                imageReferences.push({ id: `asset:location:${String(location.id)}`, role: "scene", label: `${referenceKey} 场景锚点` });
            } else if (anchor) {
                imageReferences.push({ id: `shot:${anchor.id}`, role: "scene", label: `${referenceKey} 场景锚点` });
            }
            const previous = project.shots[index - 1];
            const next = project.shots[index + 1];
            if ((previous?.locationId || previous?.sceneId) === referenceKey && previous?.id !== anchor?.id) {
                imageReferences.push({ id: `shot:${previous.id}`, role: "continuity", label: `前一镜 ${previous.id}` });
            }
            if ((next?.locationId || next?.sceneId) === referenceKey && next?.id !== anchor?.id) {
                imageReferences.push({ id: `shot:${next.id}`, role: "continuity", label: `后一镜 ${next.id}` });
            }
            const textLocks = referenceTextLocks(project, shot);
            const customReferences = (shot.customReferences || []).map(({ file: _file, ...reference }) => reference);
            return { ...shot, customReferences, imageReferences: uniqueById(imageReferences).slice(0, 10), textLocks };
        });
        const exports = await readExports(root);
        const displayTitle = await projectDisplayTitle(root, project.title);
        const approved = shots.filter((shot) => shot.reviewStatus === "approved").length;
        const changed = shots.filter((shot) => shot.versions.length > 1).length;
        return {
            ...project,
            title: displayTitle,
            projectRoot: root,
            shots,
            exports,
            stats: { total: shots.length, approved, pending: shots.length - approved, changed },
        };
    }
}

async function projectDisplayTitle(root: string, fallback: string) {
    try {
        const result = JSON.parse(await readFile(path.join(root, "formal_shot_results.json"), "utf8")) as { title?: string };
        return result.title?.trim() || fallback;
    } catch {
        return fallback;
    }
}

async function importProject(root: string, projectId: string): Promise<ReviewProject> {
    const [shotManifest, media, assetBible] = await Promise.all([
        readJson(path.join(root, "shot_manifest.json")),
        readJson(path.join(root, "media-export-manifest.json")),
        readJson(path.join(root, "ASSET_BIBLE.json")),
    ]);
    const mediaFiles = new Map(((media.files as Array<Record<string, unknown>>) || []).map((item) => [String(item.shot_id), item]));
    const shots = ((shotManifest.shots as Array<Record<string, any>>) || []).map((item, index): ReviewShot => {
        const shotId = String(item.id);
        const frameFile = path.join(root, "frames-16x9", `${shotId}.png`);
        const mediaItem = mediaFiles.get(shotId);
        const sourceFile = fileExistsSync(frameFile) ? frameFile : String(mediaItem?.file || "");
        if (!sourceFile) throw new Error(`镜头 ${shotId} 没有可用图片`);
        const relativeFile = posixPath(path.relative(root, sourceFile));
        if (relativeFile.startsWith("..")) throw new Error(`镜头 ${shotId} 图片不在项目目录内`);
        const bytes = readFileSyncSafe(sourceFile);
        const narration = item.narration || {};
        return {
            id: shotId,
            index: index + 1,
            chapterId: String(item.chapter_id || ""),
            sceneId: String(item.scene_id || ""),
            locationId: String(item.location_id || ""),
            characterIds: Array.isArray(item.characters) ? item.characters.map(String) : Array.isArray(item.character_ids) ? item.character_ids.map(String) : [],
            function: String(item.function || ""),
            visual: String(item.visual || ""),
            composition: String(item.composition || ""),
            prompt: String(item.prompt || ""),
            narration: {
                vo: String(narration.vo || ""),
                sourceExcerpt: String(narration.source_excerpt || ""),
                startSample: Number(narration.start_sample || 0),
                endSample: Number(narration.end_sample || 0),
                startSeconds: Number(narration.start_seconds || 0),
                endSeconds: Number(narration.end_seconds || 0),
                durationSeconds: Number(narration.duration_seconds || 0),
                startFrame: Number(narration.start_frame || 0),
                endFrame: Number(narration.end_frame || 0),
            },
            reviewStatus: "pending",
            reviewNote: "",
            selectedVersionId: "v001",
            customReferences: [],
            versions: [{
                id: "v001",
                createdAt: new Date().toISOString(),
                source: "original",
                file: relativeFile,
                mimeType: String(mediaItem?.mime_type || "image/png"),
                width: fileExistsSync(frameFile) ? 1536 : Number(mediaItem?.width || 0),
                height: fileExistsSync(frameFile) ? 864 : Number(mediaItem?.height || 0),
                sha256: bytes ? sha256(bytes) : String(mediaItem?.sha256 || ""),
                note: "首次成片采用版本",
            }],
        };
    });
    const deliverablesDir = path.join(root, "deliverables");
    const deliverables = await readdir(deliverablesDir);
    const audioName = deliverables.find((name) => /\.wav$/i.test(name));
    const subtitleName = deliverables.find((name) => /\.srt$/i.test(name));
    const videoName = deliverables.find((name) => /\.mp4$/i.test(name));
    if (!audioName || !subtitleName) throw new Error("项目缺少独立配音或 SRT 字幕文件");
    const timeline = (shotManifest.timeline || {}) as Record<string, unknown>;
    const style = (assetBible.style || {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    return {
        schemaVersion: "1.0",
        id: projectId,
        canvasProjectId: String(media.project_id || projectId),
        title: String((media.title as string) || shotManifest.project || projectId),
        createdAt: now,
        updatedAt: now,
        timeline: {
            fps: 30,
            sampleRate: 48_000,
            totalFrames: Number(timeline.total_frames || 0),
            totalSamples: Number(timeline.total_samples || 0),
            totalSeconds: Number(timeline.total_seconds || 0),
        },
        delivery: {
            audioFile: posixPath(path.join("deliverables", audioName)),
            subtitleFile: posixPath(path.join("deliverables", subtitleName)),
            ...(videoName ? { sourceVideoFile: posixPath(path.join("deliverables", videoName)) } : {}),
        },
        style: {
            description: String(style.description || ""),
            referenceFile: style.master && fileExistsSync(path.join(root, String(style.master))) ? posixPath(String(style.master)) : undefined,
        },
        assetBible: {
            characters: Array.isArray(assetBible.characters) ? assetBible.characters as Array<Record<string, unknown>> : [],
            locations: Array.isArray(assetBible.locations) ? assetBible.locations as Array<Record<string, unknown>> : [],
            props: Array.isArray(assetBible.props) ? assetBible.props as Array<Record<string, unknown>> : [],
        },
        shots,
    };
}

async function readExports(root: string) {
    const directory = path.join(root, "review", "exports");
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        const exports = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            try {
                const receipt = JSON.parse(await readFile(path.join(directory, entry.name, "receipt.json"), "utf8")) as Record<string, unknown>;
                exports.push(receipt);
            } catch {}
        }
        return exports.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    } catch {
        return [];
    }
}

function referenceTextLocks(project: ReviewProject, shot: ReviewShot) {
    const haystack = `${shot.visual}\n${shot.prompt}`;
    const characterLocks = project.assetBible.characters
        .filter((item) => (shot.characterIds || []).includes(String(item.id || "")) || haystack.includes(String(item.name || "")))
        .map((item) => ({ role: "character", label: String(item.name || item.id || "人物"), text: String(item.identity_lock || "") }))
        .filter((item) => item.text);
    const location = project.assetBible.locations.find((item) => item.id === shot.locationId);
    const locationLock = location ? [{ role: "location", label: String(location.name || location.id || "场景"), text: String(location.lock || "") }] : [];
    return [...characterLocks, ...locationLock, { role: "style", label: "画风", text: project.style.description }].filter((item) => item.text);
}

async function persistProject(file: string, project: ReviewProject) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await rename(temporary, file);
}

async function readJson(file: string) {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as Record<string, any>;
}

function requiredShot(project: ReviewProject, shotId: string) {
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) throw new Error(`镜头 ${shotId} 不存在`);
    return shot;
}

function safeProjectFile(root: string, relativeFile: string) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, relativeFile);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("文件路径超出项目目录");
    return resolved;
}

function validateId(value: string) {
    const id = String(value || "").trim();
    if (!/^[A-Za-z0-9_-]{3,100}$/.test(id)) throw new Error("项目标识无效");
    return id;
}

function nextVersionId(versions: ShotVersion[]) {
    const next = Math.max(0, ...versions.map((item) => Number(item.id.replace(/^v/, "")) || 0)) + 1;
    return `v${String(next).padStart(3, "0")}`;
}

function nextReferenceId(references: ShotCustomReference[]) {
    const next = Math.max(0, ...references.map((item) => Number(item.id.replace(/^ref-/, "")) || 0)) + 1;
    return `ref-${String(next).padStart(3, "0")}`;
}

function decodeImageDataUrl(value: unknown) {
    const match = String(value || "").match(IMAGE_DATA_URL);
    if (!match) throw new Error("只支持 PNG、JPEG 或 WebP 图片");
    const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("图片为空或超过 20MB");
    const mimeType = match[1];
    const extension = mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".jpg";
    return { bytes, mimeType, extension };
}

function positiveInteger(value: unknown, fallback: number) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function optionalString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 20_000) : undefined;
}

function sha256(value: Buffer) {
    return createHash("sha256").update(value).digest("hex");
}

function posixPath(value: string) {
    return value.replace(/\\/g, "/");
}

function uniqueById<T extends { id: string }>(items: T[]) {
    return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function fileExistsSync(file: string) {
    return existsSync(file);
}

function readFileSyncSafe(file: string) {
    try {
        return readFileSync(file);
    } catch {
        return null;
    }
}
