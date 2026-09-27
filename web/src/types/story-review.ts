export type StoryReviewStatus = "pending" | "approved" | "needs_changes";

export type StoryReviewVersion = {
    id: string;
    createdAt: string;
    source: "original" | "generated" | "uploaded";
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

export type StoryReviewCustomReference = {
    id: string;
    createdAt: string;
    label: string;
    mimeType: string;
    width: number;
    height: number;
    sha256: string;
    active: boolean;
};

export type StoryReviewReference = {
    id: string;
    role: "style" | "scene" | "continuity" | string;
    label: string;
};

export type StoryReviewTextLock = {
    role: "character" | "location" | "style" | string;
    label: string;
    text: string;
};

export type StoryReviewShot = {
    id: string;
    index: number;
    chapterId: string;
    sceneId: string;
    locationId: string;
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
    reviewStatus: StoryReviewStatus;
    reviewNote: string;
    selectedVersionId: string;
    versions: StoryReviewVersion[];
    customReferences: StoryReviewCustomReference[];
    imageReferences: StoryReviewReference[];
    textLocks: StoryReviewTextLock[];
};

export type StoryReviewExport = {
    schemaVersion: string;
    id: string;
    projectId: string;
    createdAt: string;
    files: Record<string, { path: string; sha256: string; frames?: number; durationSeconds?: number }>;
};

export type StoryReviewProject = {
    schemaVersion: string;
    id: string;
    canvasProjectId: string;
    title: string;
    projectRoot: string;
    timeline: { fps: number; sampleRate: number; totalFrames: number; totalSamples: number; totalSeconds: number };
    delivery: { audioFile: string; subtitleFile: string; sourceVideoFile?: string };
    style: { description: string; referenceFile?: string };
    shots: StoryReviewShot[];
    exports: StoryReviewExport[];
    stats: { total: number; approved: number; pending: number; changed: number };
};

export type StoryReviewExportJob = {
    id: string;
    projectId: string;
    status: "running" | "succeeded" | "failed";
    createdAt: string;
    finishedAt?: string;
    progress: number;
    currentShot?: string;
    error?: string;
};
