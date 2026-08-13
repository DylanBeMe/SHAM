'use strict';

function resetEditor(message = 'Select a text file') {
  state.selectedFile = null;
  state.editorDirty = false;
  $('#editor-path').textContent = message;
  $('#editor-meta').textContent = '';
  $('#document-editor').value = '';
  $('#document-editor').disabled = true;
  $('#save-file').disabled = true;
  $('#editor-status').textContent = '';
  renderFileList();
}

async function openFiles(site) {
  state.fileListRequest += 1;
  state.fileContentRequest += 1;
  state.fileSite = site;
  state.files = [];
  $('#files-site-id').value = site.id;
  $('#files-title').textContent = `${site.name} files`;
  $('#restart-file-site').textContent = site.runtime.running ? 'Restart site' : 'Start site';
  resetEditor();
  $('#file-search').value = '';
  showModal($('#files-dialog'));
  await loadFiles();
}

async function loadFiles() {
  if (!state.fileSite) return;
  const siteId = state.fileSite.id;
  const requestId = ++state.fileListRequest;
  try {
    const result = await api(`/api/sites/${siteId}/files`);
    if (!state.fileSite || state.fileSite.id !== siteId || requestId !== state.fileListRequest) return;
    state.files = result.files;
    renderFileList();
  } catch (error) {
    if (state.fileSite?.id === siteId && requestId === state.fileListRequest) toast(error.message, 'error');
  }
}

function renderFileList() {
  const query = $('#file-search').value.trim().toLowerCase();
  const matches = state.files.filter((file) => file.path.toLowerCase().includes(query));
  const visible = matches.slice(0, 500);
  const notice = matches.length > visible.length
    ? `<p class="file-limit-note muted">Showing 500 of ${formatNumber(matches.length)} matches. Refine the filter to find more.</p>`
    : '';
  $('#file-list').innerHTML = visible.length
    ? `${visible.map((file) => `<button class="file-item ${state.selectedFile?.path === file.path ? 'active' : ''}" data-file-path="${escapeHtml(file.path)}" type="button" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</button>`).join('')}${notice}`
    : '<p class="muted">No matching files.</p>';
}

$('#file-search').addEventListener('input', renderFileList);

$('#file-list').addEventListener('click', async (event) => {
  const item = event.target.closest('[data-file-path]');
  if (!item) return;
  if (state.editorDirty && !(await requestAction({ title: 'Discard unsaved changes?', message: 'Opening another file will discard the current editor changes.', confirmLabel: 'Discard changes', danger: true }))) return;
  await openEditorFile(item.dataset.filePath);
});

async function openEditorFile(filePath) {
  if (!state.fileSite) return false;
  const siteId = state.fileSite.id;
  const requestId = ++state.fileContentRequest;
  try {
    const file = await api(`/api/sites/${siteId}/files/content?path=${encodeURIComponent(filePath)}`);
    if (!state.fileSite || state.fileSite.id !== siteId || requestId !== state.fileContentRequest) return false;
    state.selectedFile = file;
    state.editorDirty = false;
    $('#editor-path').textContent = file.path;
    $('#editor-meta').textContent = `${formatBytes(file.size)} · ${formatDate(file.modifiedAt)}`;
    $('#document-editor').value = file.content;
    $('#document-editor').disabled = false;
    $('#save-file').disabled = false;
    $('#editor-status').textContent = 'Saved';
    renderFileList();
    return true;
  } catch (error) {
    if (state.fileSite?.id === siteId && requestId === state.fileContentRequest) toast(error.message, 'error');
    return false;
  }
}

$('#document-editor').addEventListener('input', () => {
  if (!state.selectedFile) return;
  state.editorDirty = true;
  $('#editor-status').textContent = 'Unsaved changes';
});

$('#document-editor').addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const editor = event.target;
    const start = editor.selectionStart;
    editor.setRangeText('  ', start, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input'));
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    $('#save-file').click();
  }
});

$('#new-file').addEventListener('click', async () => {
  if (state.editorDirty && !(await requestAction({ title: 'Discard unsaved changes?', message: 'Creating a new file will discard the current editor changes.', confirmLabel: 'Discard changes', danger: true }))) return;
  const pathValue = await requestAction({ title: 'Create a file', message: 'Use a relative path inside this site.', confirmLabel: 'Create file', inputLabel: 'Relative file path', placeholder: 'src/config.json' });
  if (!pathValue) return;
  state.selectedFile = { path: pathValue, content: '', size: 0, modifiedAt: null };
  state.editorDirty = true;
  $('#editor-path').textContent = pathValue;
  $('#editor-meta').textContent = 'New file';
  $('#document-editor').value = '';
  $('#document-editor').disabled = false;
  $('#save-file').disabled = false;
  $('#editor-status').textContent = 'Not saved';
  $('#document-editor').focus();
  renderFileList();
});

$('#save-file').addEventListener('click', async () => {
  if (!state.selectedFile) return;
  const button = $('#save-file');
  setBusy(button, true, 'Saving…');
  try {
    const result = await api(`/api/sites/${state.fileSite.id}/files/content`, {
      method: 'PUT',
      body: { path: state.selectedFile.path, content: $('#document-editor').value }
    });
    state.editorDirty = false;
    $('#editor-status').textContent = result.restartRecommended ? 'Saved · restart recommended' : 'Saved';
    toast(result.restartRecommended ? 'File saved. Restart the Node.js site to load server-side changes.' : 'File saved.');
    await loadFiles();
    await openEditorFile(state.selectedFile.path);
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#replace-file').addEventListener('click', async () => {
  if (state.editorDirty && !(await requestAction({ title: 'Discard unsaved changes?', message: 'Replacing this file will discard the current editor changes.', confirmLabel: 'Discard and replace', danger: true }))) return;
  let target = state.selectedFile?.path;
  if (!target) target = await requestAction({ title: 'Replace a file', message: 'Choose the destination path, then select the replacement file.', confirmLabel: 'Choose file', inputLabel: 'Relative destination path', placeholder: 'assets/logo.svg' });
  if (!target) return;
  $('#single-file-input').dataset.path = target;
  $('#single-file-input').click();
});

$('#single-file-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  const target = event.target.dataset.path;
  event.target.value = '';
  if (!file || !target) return;
  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('path', target);
  const button = $('#replace-file');
  setBusy(button, true, 'Replacing…');
  try {
    const result = await api(`/api/sites/${state.fileSite.id}/files/upload`, { method: 'PUT', body: formData });
    toast(result.restartRecommended ? 'File replaced. Restart the Node.js site to load changes.' : 'File replaced.');
    state.editorDirty = false;
    await loadFiles();
    if (!(await openEditorFile(target))) resetEditor('Preview unavailable for this file');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#delete-file').addEventListener('click', async () => {
  if (!state.selectedFile) return toast('Select a file first.', 'error');
  if (!(await requestAction({ title: `Delete ${state.selectedFile.path}?`, message: 'This file will be permanently removed from the site.', confirmLabel: 'Delete file', danger: true }))) return;
  const button = $('#delete-file');
  setBusy(button, true, 'Deleting…');
  try {
    const result = await api(`/api/sites/${state.fileSite.id}/files?path=${encodeURIComponent(state.selectedFile.path)}`, { method: 'DELETE' });
    toast(result.warning || 'File deleted.', result.warning ? 'warning' : 'success');
    resetEditor();
    await Promise.all([loadFiles(), loadSites()]);
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('#restart-file-site').addEventListener('click', async (event) => {
  if (!state.fileSite) return;
  const wasRunning = state.fileSite.runtime.running;
  setBusy(event.target, true, wasRunning ? 'Restarting…' : 'Starting…');
  try {
    await api(`/api/sites/${state.fileSite.id}/restart`, { method: 'POST' });
    toast(wasRunning ? 'Site restarted.' : 'Site started.');
    await loadSites();
    state.fileSite = state.sites.find((site) => site.id === state.fileSite.id) || state.fileSite;
    event.target.textContent = 'Restart site';
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.target, false); }
});
