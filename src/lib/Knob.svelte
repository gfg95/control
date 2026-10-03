<script lang="ts">
	import { ccName, defaultValue, fmParam, formatReal } from './midi.ts';

	interface Props {
		index: number;
		cc: number;
		value: number;
		/** L'interface est pivotée de 90° (téléphone tenu en portrait). */
		rotated?: boolean;
		onchange: (value: number) => void;
		onassign: () => void;
	}

	let { index, cc, value, rotated = false, onchange, onassign }: Props = $props();

	const param = $derived(fmParam(cc));
	const name = $derived(ccName(cc));
	const readout = $derived(param ? formatReal(param, value) : '');
	/** −135° à +135° autour de la verticale. */
	const angle = $derived(-135 + (value / 127) * 270);

	/** Course du doigt, en pixels, pour balayer 0 → 127. */
	const TRAVEL = 180;
	let drag: { id: number; x: number; y: number; from: number } | null = null;
	let turning = $state(false);

	function down(event: PointerEvent) {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY, from: value };
		turning = true;
	}

	function move(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.id) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		// Vers le haut ou vers la droite de l'interface : la valeur monte.
		// Pivotée de 90°, « haut » devient l'axe x de l'écran et « droite » son axe y.
		const travel = rotated ? dx + dy : dx - dy;
		const fine = event.shiftKey ? 0.25 : 1;
		onchange(drag.from + (travel / TRAVEL) * 127 * fine);
	}

	function up(event: PointerEvent) {
		if (drag && event.pointerId === drag.id) {
			drag = null;
			turning = false;
		}
	}

	function wheel(event: WheelEvent) {
		event.preventDefault();
		onchange(value + (event.deltaY < 0 ? 1 : -1));
	}

	function keydown(event: KeyboardEvent) {
		const steps: Record<string, number> = {
			ArrowUp: 1,
			ArrowRight: 1,
			ArrowDown: -1,
			ArrowLeft: -1,
			PageUp: 10,
			PageDown: -10
		};
		if (event.key in steps) onchange(value + steps[event.key]);
		else if (event.key === 'Home') onchange(0);
		else if (event.key === 'End') onchange(127);
		else return;
		event.preventDefault();
	}

	function reset() {
		onchange(defaultValue(cc) ?? 64);
	}
</script>

<div class="knob" class:turning>
	<div
		class="dial"
		role="slider"
		tabindex="0"
		aria-label="Potentiomètre {index + 1}, {name}, CC {cc}"
		aria-valuemin={0}
		aria-valuemax={127}
		aria-valuenow={value}
		aria-valuetext="{value}{param ? `, ${readout}` : ''}"
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		onlostpointercapture={up}
		onwheel={wheel}
		onkeydown={keydown}
		ondblclick={reset}
		oncontextmenu={(event) => event.preventDefault()}
	>
		<svg viewBox="0 0 64 64" aria-hidden="true">
			<circle class="track" cx="32" cy="32" r="28" pathLength="360" transform="rotate(135 32 32)" />
			<circle
				class="level"
				cx="32"
				cy="32"
				r="28"
				pathLength="360"
				stroke-dasharray="{(value / 127) * 270} 360"
				transform="rotate(135 32 32)"
			/>
			<circle class="cap" cx="32" cy="32" r="21" />
			<line class="pointer" x1="32" y1="13" x2="32" y2="18" transform="rotate({angle} 32 32)" />
			<text class="number" x="32" y="37.5" text-anchor="middle">{value}</text>
		</svg>
	</div>

	<button class="assign" type="button" onclick={onassign} aria-label="Assigner le potentiomètre {index + 1}, actuellement {name}, CC {cc}">
		<span class="name">{name}</span>
		<span class="cc">{param ? `CC ${cc}` : 'non mappé'}</span>
	</button>
	{#if param}<span class="readout">{readout}</span>{/if}
</div>

<style>
	.knob {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		min-width: 0;
	}

	.dial {
		width: var(--knob-size, 72px);
		aspect-ratio: 1;
		border-radius: 50%;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		cursor: grab;
	}

	.turning .dial {
		cursor: grabbing;
	}

	svg {
		display: block;
		width: 100%;
		height: 100%;
	}

	.track,
	.level {
		fill: none;
		stroke-width: 4;
		stroke-linecap: round;
	}

	.track {
		stroke: var(--creux);
		stroke-dasharray: 270 360;
	}

	.level {
		stroke: var(--cobalt);
	}

	.cap {
		fill: var(--coque-claire);
		stroke: var(--filet);
		stroke-width: 1;
	}

	.pointer {
		stroke: var(--encre);
		stroke-width: 3;
		stroke-linecap: round;
	}

	.number {
		font-size: 14px;
		font-weight: 600;
		fill: var(--encre);
	}

	.turning .number {
		fill: var(--cobalt);
	}

	.assign {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 3px 4px;
		border: 0;
		border-radius: 5px;
		background: none;
		font-size: var(--knob-label, 14px);
		font-weight: 600;
		line-height: 1.15;
		cursor: pointer;
	}

	.assign:hover {
		background: var(--creux);
	}

	/* Les noms viennent d'une table fixe : le plus long peut déborder un peu de sa colonne. */
	.name {
		white-space: nowrap;
	}

	.cc {
		font-size: 12px;
		font-weight: 500;
		color: var(--encre-douce);
		white-space: nowrap;
	}

	.readout {
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
	}
</style>
