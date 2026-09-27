import { fetchAgentJson } from "@/components/agent/agent-api";
import { useAgentStore } from "@/stores/use-agent-store";
import type { StoryReviewExportJob, StoryReviewProject, StoryReviewStatus } from "@/types/story-review";

type ProjectResponse = { ok: true; project: StoryReviewProject };
type MutationResponse = { ok: true; project: StoryReviewProject; result: unknown };

export function storyReviewConnection() {
    const { url, token, connected } = useAgentStore.getState();
    const search = new URLSearchParams(window.location.search);
    const queryUrl = search.get("agentUrl")?.trim();
    const queryToken = search.get("agentToken")?.trim();
    const parsed = new URL(queryUrl || (connected ? url : "http://127.0.0.1:17371"));
    if (["127.0.0.1", "localhost"].includes(parsed.hostname) && !["127.0.0.1", "localhost"].includes(window.location.hostname)) parsed.hostname = window.location.hostname;
    return { endpoint: parsed.toString().replace(/\/$/, ""), token: queryToken || token };
}

export async function fetchStoryReviewProject(projectId: string) {
    const { endpoint, token } = storyReviewConnection();
    return (await fetchAgentJson<ProjectResponse>(endpoint, token, `/story-review/projects/${encodeURIComponent(projectId)}`)).project;
}

export function storyReviewVersionImageUrl(projectId: string, shotId: string, versionId: string) {
    const { endpoint, token } = storyReviewConnection();
    return `${endpoint}/story-review/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/versions/${encodeURIComponent(versionId)}/image?token=${encodeURIComponent(token)}`;
}

export function storyReviewReferenceImageUrl(projectId: string, referenceId: string) {
    const { endpoint, token } = storyReviewConnection();
    return `${endpoint}/story-review/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(referenceId)}/image?token=${encodeURIComponent(token)}`;
}

export function storyReviewCustomReferenceImageUrl(projectId: string, shotId: string, referenceId: string) {
    const { endpoint, token } = storyReviewConnection();
    return `${endpoint}/story-review/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/references/${encodeURIComponent(referenceId)}/image?token=${encodeURIComponent(token)}`;
}

export async function addStoryReviewReference(projectId: string, shotId: string, input: { dataUrl: string; width: number; height: number; label: string }) {
    return mutate(projectId, `/story-review/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/references`, input);
}

export async function removeStoryReviewReference(projectId: string, shotId: string, referenceId: string) {
    return mutate(projectId, `/story-review/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/references/${encodeURIComponent(referenceId)}/remove`, {});
}

export async function addStoryReviewVersion(projectId: string, shotId: string, input: { dataUrl: string; source: "generated" | "uploaded"; width: number; height: number; prompt?: string; model?: string; note?: string; select?: boolean; referenceIds?: string[] }) {
    return mutate(projectId, `/story-review/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/versions`, input);
}

export async function selectStoryReviewVersion(projectId: string, shotId: string, versionId: string) {
    return mutate(projectId, `/story-review/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/select`, { versionId });
}

export async function setStoryReviewStatus(projectId: string, shotId: string, status: StoryReviewStatus, note: string) {
    return mutate(projectId, `/story-review/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/review`, { status, note });
}

export async function startStoryReviewExport(projectId: string) {
    const { endpoint, token } = storyReviewConnection();
    return (await fetchAgentJson<{ ok: true; job: StoryReviewExportJob }>(endpoint, token, `/story-review/projects/${encodeURIComponent(projectId)}/exports`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).job;
}

export async function fetchStoryReviewExportJob(projectId: string, exportId: string) {
    const { endpoint, token } = storyReviewConnection();
    return (await fetchAgentJson<{ ok: true; job: StoryReviewExportJob }>(endpoint, token, `/story-review/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}`)).job;
}

export function storyReviewExportFileUrl(projectId: string, exportId: string, kind: "video" | "audio" | "subtitles") {
    const { endpoint, token } = storyReviewConnection();
    return `${endpoint}/story-review/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/files/${kind}?token=${encodeURIComponent(token)}`;
}

export async function revealStoryReviewExport(projectId: string, exportId: string) {
    const { endpoint, token } = storyReviewConnection();
    return fetchAgentJson<{ ok: true; directory: string }>(endpoint, token, `/story-review/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/reveal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
}

async function mutate(projectId: string, path: string, input: unknown) {
    const { endpoint, token } = storyReviewConnection();
    return (await fetchAgentJson<MutationResponse>(endpoint, token, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).project;
}
