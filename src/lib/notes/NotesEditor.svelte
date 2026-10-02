<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Collaboration from '@tiptap/extension-collaboration';
	import TaskList from '@tiptap/extension-task-list';
	import TaskItem from '@tiptap/extension-task-item';
	import type { NotesDoc } from './notes';

	let { notes }: { notes: NotesDoc } = $props();
	let el: HTMLDivElement;
	let editor: Editor | null = null;

	onMount(() => {
		editor = new Editor({
			element: el,
			extensions: [
				StarterKit.configure({}),
				TaskList,
				TaskItem.configure({ nested: true }),
				Collaboration.configure({ fragment: notes.text })
			]
		});
	});

	onDestroy(() => editor?.destroy());
</script>

<div class="editor" bind:this={el}></div>

<style>
	.editor {
		height: 100%;
		overflow-y: auto;
		padding: 1rem;
	}
	.editor :global(.tiptap) {
		outline: none;
		min-height: 100%;
		color: var(--ink);
		font-size: 0.95rem;
		line-height: 1.6;
	}
	.editor :global(.tiptap p) {
		margin: 0 0 0.5rem;
	}
</style>
