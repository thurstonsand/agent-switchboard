import { truncateToWidth } from "@earendil-works/pi-tui";

export function presetColumns(harness: string, model: string, effort: string, provider: string) {
	return {
		harness: `${truncateToWidth(harness, 7, "…", true)}  `,
		model: `${truncateToWidth(model, 18, "…", true)}  `,
		effort: `${truncateToWidth(effort, 7, "…", true)}  `,
		provider,
	};
}

const headers = presetColumns("Harness", "Model", "Effort", "Provider");
export const PRESET_HEADER = `Key ${headers.harness}${headers.model}${headers.effort}${headers.provider}`;
