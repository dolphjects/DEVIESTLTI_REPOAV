'use strict';

(() => {
  const params = new URLSearchParams(window.location.search);
  const courseId = params.get('course_id');
  const version = document.body.dataset.reportVersion === 'pro' ? 'pro' : 'basic';
  const loadingOverlay = document.getElementById('report-loading-overlay');
  const loadingStartedAt = performance.now();

  const searchInput = document.getElementById('studentSearch');
  const moduleFilter = document.getElementById('moduleFilter');
  const reportHead = document.getElementById('reportHead');
  const reportBody = document.getElementById('reportBody');
  const downloadButton = document.getElementById('downloadCsv');
  const progressModal = document.getElementById('progressModal');
  const modalClose = document.getElementById('modalClose');
  const emailButton = document.getElementById('emailStudent');
  const modalStudent = document.getElementById('modalStudent');
  const modalModule = document.getElementById('modalModule');
  const modalProgress = document.getElementById('modalProgress');
  const modalProgressAtClose = document.getElementById('modalProgressAtClose');
  const modalProgressAfterClose = document.getElementById('modalProgressAfterClose');
  const modalViewed = document.getElementById('modalViewed');
  const modalPending = document.getElementById('modalPending');
  const modalTotal = document.getElementById('modalTotal');
  const deadlineBarSection = document.getElementById('deadlineBarSection');
  const guideVideoLink = document.getElementById('guideVideoLink');
  const guideVideoModal = document.getElementById('guideVideoModal');
  const guideVideoClose = document.getElementById('guideVideoClose');
  const guideVideoFrame = document.getElementById('guideVideoFrame');

  let course = null;
  let modules = [];
  let students = [];
  let lastFocusedElement = null;
  let sortIdAscending = true;
  let currentModalContext = null;

  function showReportLoader() {
    document.body.classList.add('report-is-loading');
    loadingOverlay?.classList.remove('is-hidden');
    loadingOverlay?.setAttribute('aria-hidden', 'false');
  }

  function hideReportLoader() {
    const minimumVisibleTime = 350;
    const elapsed = performance.now() - loadingStartedAt;
    const delay = Math.max(0, minimumVisibleTime - elapsed);

    window.setTimeout(() => {
      loadingOverlay?.classList.add('is-hidden');
      loadingOverlay?.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('report-is-loading');
    }, delay);
  }

  function clampPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }

  function normalize(value) {
    return String(value || '')
      .toLocaleLowerCase('es-MX')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
  }

  async function fetchJson(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo cargar el reporte.');
    return data;
  }

  function setCourseIdentity() {
    const title = course?.name || 'Curso';
    const code = course?.code || 'N/A';

    document.querySelectorAll('.course-title').forEach(element => {
      element.textContent = title;
    });
    document.querySelectorAll('.course-code').forEach(element => {
      element.textContent = `Código: ${code}`;
    });

    const modalCourseTitle = document.getElementById('modalCourseTitle');
    const modalCode = document.getElementById('modalCode');
    if (modalCourseTitle) modalCourseTitle.textContent = title;
    if (modalCode) modalCode.textContent = `Código: ${code}`;
  }

  function prepareStudents(rawStudents) {
    return rawStudents.map(student => ({
      ...student,
      displayId: String(student.sisUserId || student.canvasId),
      moduleMap: new Map((student.modules || []).map(item => [String(item.moduleId), item]))
    }));
  }

  function populateModuleFilter() {
    moduleFilter.replaceChildren(new Option('Todos los módulos', 'all'));
    modules.forEach((module, index) => {
      moduleFilter.add(new Option(module.name, String(index)));
    });
  }

  function activeModuleIndexes() {
    return moduleFilter.value === 'all'
      ? modules.map((_, index) => index)
      : [Number(moduleFilter.value)];
  }

  function filteredStudents() {
    const query = normalize(searchInput.value.trim());
    const rows = query
      ? students.filter(student =>
          normalize(student.name).includes(query) ||
          normalize(student.displayId).includes(query)
        )
      : [...students];

    rows.sort((a, b) => {
      const comparison = String(a.displayId).localeCompare(
        String(b.displayId),
        undefined,
        { numeric: true }
      );
      return sortIdAscending ? comparison : -comparison;
    });

    return rows;
  }

  function moduleRecord(student, moduleIndex) {
    const module = modules[moduleIndex];
    return student.moduleMap.get(String(module.id)) || {
      moduleId: module.id,
      totalPct: 0,
      atClosePct: 0,
      afterClosePct: 0,
      viewedItems: 0,
      pendingItems: 0,
      totalItems: 0,
      timingAvailable: false
    };
  }

  function progressBreakdown(student, moduleIndex) {
    const record = moduleRecord(student, moduleIndex);
    const total = clampPercent(record.totalPct);
    const atClose = version === 'pro'
      ? Math.min(clampPercent(record.atClosePct), total)
      : total;
    const afterClose = version === 'pro'
      ? Math.min(clampPercent(record.afterClosePct), Math.max(total - atClose, 0))
      : 0;

    return {
      total,
      atClose,
      afterClose,
      pending: Math.max(100 - total, 0),
      hasWarning: atClose > 0 && afterClose > 0,
      viewedItems: Number(record.viewedItems || 0),
      pendingItems: Number(record.pendingItems || 0),
      totalItems: Number(record.totalItems || 0),
      timingAvailable: Boolean(record.timingAvailable)
    };
  }

  function progressStatus(progress) {
    const value = clampPercent(progress);
    if (value === 0) return 'white';
    if (value <= 50) return 'red';
    if (value <= 99) return 'yellow';
    return 'green';
  }

  function statusLabel(status) {
    if (status === 'white') return 'sin avance';
    if (status === 'red') return 'avance bajo';
    if (status === 'yellow') return 'avance parcial';
    return 'avance completo';
  }

  function appendProgressLabel(container, progress, hasWarning) {
    const status = progressStatus(progress);
    const value = document.createElement('span');
    value.textContent = `${progress}%`;
    container.classList.add(`is-${status}`);
    container.appendChild(value);

    if (hasWarning) {
      const warning = document.createElement('span');
      warning.className = 'progress-warning';
      warning.setAttribute('aria-hidden', 'true');
      warning.textContent = '⚠️';
      container.appendChild(warning);
    }

    return status;
  }

  function renderHead() {
    const row = document.createElement('tr');
    const idHeader = document.createElement('th');
    const nameHeader = document.createElement('th');
    const sortButton = document.createElement('button');
    const sortIndicator = document.createElement('span');

    idHeader.className = 'col-id';
    idHeader.setAttribute('aria-sort', sortIdAscending ? 'ascending' : 'descending');
    sortButton.className = 'sort-header-button';
    sortButton.type = 'button';
    sortButton.setAttribute('aria-label', 'Cambiar orden por ID IEST');
    sortButton.append('ID IEST ');
    sortIndicator.className = 'sort-indicator';
    sortIndicator.setAttribute('aria-hidden', 'true');
    sortIndicator.textContent = sortIdAscending ? '▲' : '▼';
    sortButton.appendChild(sortIndicator);
    sortButton.addEventListener('click', () => {
      sortIdAscending = !sortIdAscending;
      renderReport();
    });
    idHeader.appendChild(sortButton);

    nameHeader.className = 'col-name';
    nameHeader.textContent = 'Nombre';
    row.append(idHeader, nameHeader);

    activeModuleIndexes().forEach(moduleIndex => {
      const module = modules[moduleIndex];
      const th = document.createElement('th');
      th.className = 'col-module';
      th.textContent = module.shortName || `Módulo ${moduleIndex + 1}`;
      th.title = module.name;
      row.appendChild(th);
    });

    reportHead.replaceChildren(row);
  }

  function renderBody() {
    const rows = filteredStudents();
    const moduleIndexes = activeModuleIndexes();
    const fragment = document.createDocumentFragment();

    if (!rows.length) {
      const emptyRow = document.createElement('tr');
      const emptyCell = document.createElement('td');
      emptyRow.className = 'empty-row';
      emptyCell.colSpan = moduleIndexes.length + 2;
      emptyCell.textContent = 'No se encontraron alumnos con esos filtros.';
      emptyRow.appendChild(emptyCell);
      reportBody.replaceChildren(emptyRow);
      return;
    }

    rows.forEach(student => {
      const row = document.createElement('tr');
      const idCell = document.createElement('td');
      const nameCell = document.createElement('td');

      idCell.textContent = student.displayId;
      nameCell.textContent = student.name;
      row.append(idCell, nameCell);

      moduleIndexes.forEach(moduleIndex => {
        const progressCell = document.createElement('td');
        const progressButton = document.createElement('button');
        const breakdown = progressBreakdown(student, moduleIndex);
        const status = progressStatus(breakdown.total);

        progressButton.className = 'progress-button';
        progressButton.type = 'button';
        appendProgressLabel(progressButton, breakdown.total, version === 'pro' && breakdown.hasWarning);
        progressButton.setAttribute(
          'aria-label',
          `Ver detalle de ${modules[moduleIndex].name} para ${student.name}. ` +
          `Avance ${breakdown.total}%, ${statusLabel(status)}` +
          (breakdown.hasWarning ? ', con avance posterior al cierre' : '')
        );
        progressButton.addEventListener('click', () => openProgressModal(student, moduleIndex));

        progressCell.appendChild(progressButton);
        row.appendChild(progressCell);
      });

      fragment.appendChild(row);
    });

    reportBody.replaceChildren(fragment);
  }

  function createDeadlineSegment(className, value, label, tooltipText = '') {
    const segment = document.createElement('span');
    segment.className = `deadline-segment ${className}`;
    segment.style.flexBasis = `${Math.max(value, 0)}%`;
    segment.textContent = value > 0 ? label : '';

    if (value > 0 && tooltipText) {
      segment.dataset.tooltip = tooltipText;
      segment.tabIndex = 0;
      ['mouseenter', 'focus'].forEach(eventName => {
        segment.addEventListener(eventName, () => segment.classList.add('is-tooltip-visible'));
      });
      ['mouseleave', 'blur'].forEach(eventName => {
        segment.addEventListener(eventName, () => segment.classList.remove('is-tooltip-visible'));
      });
    }

    if (value <= 0) segment.style.display = 'none';
    return segment;
  }

  function createDeadlineBar(breakdown) {
    const section = document.createElement('div');
    const progress = document.createElement('div');
    const marker = document.createElement('span');

    section.className = 'deadline-bar-inner';
    progress.className = `deadline-progress${breakdown.afterClose > 0 ? ' has-late' : ''}`;
    marker.className = 'deadline-marker';
    marker.textContent = '⚠️';
    marker.style.left = `${Math.max(breakdown.atClose, 0)}%`;

    if (breakdown.total === 0) {
      progress.appendChild(createDeadlineSegment('is-empty is-only', 100, '0 %'));
    } else {
      const beforeClass = breakdown.afterClose === 0 && breakdown.pending === 0
        ? 'is-before is-complete'
        : 'is-before';
      const afterClass = breakdown.atClose === 0 && breakdown.pending === 0
        ? 'is-after is-complete'
        : 'is-after';

      progress.append(
        createDeadlineSegment(beforeClass, breakdown.atClose, `${breakdown.atClose}%`, 'Avance al cierre del módulo.'),
        createDeadlineSegment(afterClass, breakdown.afterClose, `${breakdown.afterClose}%`, 'Avance posterior al cierre del módulo.'),
        createDeadlineSegment('is-empty', breakdown.pending, '')
      );
    }

    progress.appendChild(marker);
    section.appendChild(progress);
    return section;
  }

  function reminderEmailBody(context) {
    const lines = [
      'Hola, te recuerdo que es importante visualizar todos los contenidos de cada módulo dentro de las fechas establecidas, ya que esto permitirá que se registre correctamente tu porcentaje de avance en la materia. ¡Gracias por tu apoyo y compromiso!',
      '',
      'Datos de la tabla:',
      `Alumno: ${context.student.name}`,
      `Módulo: ${context.module.name}`
    ];

    if (version === 'pro') {
      lines.push(
        `Avance al cierre: ${context.breakdown.atClose}%`,
        `Avance posterior al cierre: ${context.breakdown.afterClose}%`
      );
    } else {
      lines.push(`Avance: ${context.breakdown.total}%`);
    }

    lines.push(
      `Ítems vistos: ${context.breakdown.viewedItems}`,
      `Ítems pendientes: ${context.breakdown.pendingItems}`,
      `Total de ítems: ${context.breakdown.totalItems}`
    );

    return lines.join('\n');
  }

  function gmailComposeUrl(context) {
    const url = new URL('https://mail.google.com/mail/');
    url.searchParams.set('view', 'cm');
    url.searchParams.set('fs', '1');
    url.searchParams.set('tf', '1');

    if (String(context.student.email || '').includes('@')) {
      url.searchParams.set('to', context.student.email);
    }

    url.searchParams.set('su', `Recordatorio de avance - ${context.module.name}`);
    url.searchParams.set('body', reminderEmailBody(context));
    return url.toString();
  }

  function sendReminderEmail() {
    if (!currentModalContext) return;
    const composeUrl = gmailComposeUrl(currentModalContext);
    const gmailWindow = window.open(composeUrl, '_blank');

    if (gmailWindow) {
      try {
        gmailWindow.opener = null;
      } catch (error) {
        // Algunos navegadores bloquean esta propiedad.
      }
    } else {
      window.location.href = composeUrl;
    }
  }

  function openProgressModal(student, moduleIndex) {
    const breakdown = progressBreakdown(student, moduleIndex);
    const module = modules[moduleIndex];

    lastFocusedElement = document.activeElement;
    currentModalContext = { student, module, breakdown };

    modalStudent.textContent = student.name;
    modalModule.textContent = module.name;
    if (modalProgress) modalProgress.textContent = `${breakdown.total}%`;
    if (modalProgressAtClose) modalProgressAtClose.textContent = `${breakdown.atClose}%`;
    if (modalProgressAfterClose) modalProgressAfterClose.textContent = `${breakdown.afterClose}%`;
    modalViewed.textContent = breakdown.viewedItems;
    modalPending.textContent = breakdown.pendingItems;
    modalTotal.textContent = breakdown.totalItems;

    if (deadlineBarSection) {
      deadlineBarSection.replaceChildren(createDeadlineBar(breakdown));
    }

    progressModal.classList.add('is-open');
    progressModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    modalClose.focus();
  }

  function closeProgressModal() {
    progressModal.classList.remove('is-open');
    progressModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    currentModalContext = null;
    if (lastFocusedElement) lastFocusedElement.focus();
  }

  function openGuideVideoModal(event) {
    if (!guideVideoModal || !guideVideoFrame) return;
    event?.preventDefault();
    lastFocusedElement = document.activeElement;
    guideVideoFrame.src = guideVideoFrame.dataset.src || guideVideoLink.href;
    guideVideoModal.classList.add('is-open');
    guideVideoModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    guideVideoClose.focus();
  }

  function closeGuideVideoModal() {
    if (!guideVideoModal || !guideVideoFrame) return;
    guideVideoModal.classList.remove('is-open');
    guideVideoModal.setAttribute('aria-hidden', 'true');
    guideVideoFrame.src = '';
    document.body.style.overflow = '';
    if (lastFocusedElement) lastFocusedElement.focus();
  }

  function renderReport() {
    renderHead();
    renderBody();
  }

  function csvValue(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  function downloadCsv() {
    const moduleIndexes = activeModuleIndexes();
    const headers = [
      'ID IEST',
      'Nombre',
      ...moduleIndexes.map(index => modules[index].name)
    ];
    const rows = filteredStudents().map(student => [
      student.displayId,
      student.name,
      ...moduleIndexes.map(index => `${progressBreakdown(student, index).total}%`)
    ]);

    const csv = '\uFEFF' + [headers, ...rows]
      .map(row => row.map(csvValue).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'reporte_de_avance.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function renderLoading() {
    reportBody.innerHTML = '<tr class="empty-row"><td colspan="12">Cargando información de Canvas...</td></tr>';
  }

  function renderError(error) {
    reportBody.innerHTML = `<tr class="empty-row"><td colspan="12">${escapeHtml(error.message)}</td></tr>`;
  }

  function setupEvents() {
    searchInput.addEventListener('input', renderBody);
    moduleFilter.addEventListener('change', renderReport);
    downloadButton.addEventListener('click', downloadCsv);
    emailButton.addEventListener('click', sendReminderEmail);
    modalClose.addEventListener('click', closeProgressModal);

    progressModal.addEventListener('click', event => {
      if (event.target === progressModal) closeProgressModal();
    });

    if (guideVideoLink) guideVideoLink.addEventListener('click', openGuideVideoModal);
    if (guideVideoClose) guideVideoClose.addEventListener('click', closeGuideVideoModal);
    if (guideVideoModal) {
      guideVideoModal.addEventListener('click', event => {
        if (event.target === guideVideoModal) closeGuideVideoModal();
      });
    }

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (guideVideoModal?.classList.contains('is-open')) {
        closeGuideVideoModal();
        return;
      }
      if (progressModal.classList.contains('is-open')) closeProgressModal();
    });
  }

  async function initialize() {
    showReportLoader();
    setupEvents();
    renderLoading();

    try {
      if (!courseId) throw new Error('No se recibió course_id en la URL.');

      const query = new URLSearchParams({
        course_id: courseId,
        role: 'teacher',
        version
      });
      const data = await fetchJson(`/api/report-data?${query.toString()}`);

      course = data.course;
      modules = data.modules || [];
      students = prepareStudents(data.students || []);
      setCourseIdentity();
      populateModuleFilter();
      renderReport();
    } catch (error) {
      console.error(error);
      renderError(error);
    } finally {
      hideReportLoader();
    }
  }

  initialize();
})();
