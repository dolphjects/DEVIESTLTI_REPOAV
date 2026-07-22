'use strict';

(() => {
  const params = new URLSearchParams(window.location.search);
  const courseId = params.get('course_id');
  const userId = params.get('user_id');
  const version = document.body.dataset.reportVersion === 'pro' ? 'pro' : 'basic';
  const loadingOverlay = document.getElementById('report-loading-overlay');
  const loadingStartedAt = performance.now();

  const courseTitle = document.getElementById('courseTitle');
  const courseCode = document.getElementById('courseCode');
  const studentName = document.getElementById('studentName');
  const moduleRows = document.getElementById('moduleRows');
  const phraseDay = document.getElementById('phraseDay');
  const phraseText = document.getElementById('phraseText');
  const progressTooltip = document.createElement('div');

  const motivationalPhrases = {
    lunes: [
      'Hoy es el día perfecto para retomar tu ritmo y demostrarte de lo que eres capaz.',
      'Lunes con intención: una nueva oportunidad de avanzar sin prisa.',
      'Empieza la semana con calma: un pequeño avance hoy te ahorrará prisas después.',
      'Inicia la semana con intención: un pequeño avance hoy marca la diferencia.'
    ],
    martes: [
      'Aprovecha el impulso: lo que hagas hoy construye tu éxito de mañana.',
      'Martes con impulso: ideal para avanzar un poco más; tu viernes ya te está agradeciendo.',
      'Aprovecha el impulso; tu yo del viernes te lo va a agradecer.',
      'Consolida tu avance; cada acción en este día fortalece tu progreso.'
    ],
    miercoles: [
      'Vas a la mitad de la semana y también más lejos de lo que crees. ¡Sigue así!',
      'Miércoles de equilibrio: un pequeño empujón y la semana se ve distinta.',
      'Mitad de semana: avanza un poco y verás cómo todo se siente más ligero.',
      'Mitad de semana: mira lo que has logrado y sigue avanzando.'
    ],
    jueves: [
      'Hoy es un buen día para descubrir algo nuevo y sorprenderte de tu capacidad.',
      'Jueves con energía: si hoy das un paso, mañana te parecerá que hiciste magia.',
      'Hoy es buen día para adelantar algo y sorprenderte de lo bien que te sientes después.',
      'Cada día trae una oportunidad distinta; hoy puede ser la tuya.'
    ],
    viernes: [
      'Un empujoncito más hoy y el fin de semana será puro disfrute.',
      'Un pequeño avance hoy te permitirá disfrutar el fin de semana sin pendientes.',
      'Viernes con buena vibra: avanza lo justo para que tu descanso se sienta completo.',
      'Un avance hoy vale doble: te acerca al fin de semana sin pendientes.',
      'Lo que avances hoy te acerca a un fin de semana más ligero.'
    ],
    sabado: [
      'Tómate tu tiempo. Avanza a tu ritmo y celebra cada logro.',
      'Sábado tranquilo: un avance breve y el resto del día es tuyo.',
      'Avanza a tu ritmo; incluso un poquito cuenta y cuenta mucho.',
      'Hoy puedes avanzar sin prisa; cada paso cuenta.'
    ],
    domingo: [
      'Recarga energías, tu futuro vale cada esfuerzo.',
      'Domingo de calma: un mini avance hoy te acomoda toda la semana.',
      'Recarga energías y, si avanzas un poco, mejor aún. Tu semana te lo agradecerá.',
      'Hoy es un buen día para renovar fuerzas y seguir construyendo tu camino.'
    ]
  };

  const dayLabels = {
    domingo: 'Domingo',
    lunes: 'Lunes',
    martes: 'Martes',
    miercoles: 'Miércoles',
    jueves: 'Jueves',
    viernes: 'Viernes',
    sabado: 'Sábado'
  };
  const dayKeys = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

  progressTooltip.className = 'progress-tooltip';
  progressTooltip.setAttribute('role', 'tooltip');
  document.body.appendChild(progressTooltip);

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

  function progressStatus(value) {
    const progress = clampPercent(value);
    if (progress <= 0) return 'white';
    if (progress <= 50) return 'red';
    if (progress < 100) return 'yellow';
    return 'green';
  }

  function progressBreakdown(record) {
    const total = clampPercent(record?.totalPct);
    const atClose = version === 'pro'
      ? Math.min(clampPercent(record?.atClosePct), total)
      : total;
    const afterClose = version === 'pro'
      ? Math.min(clampPercent(record?.afterClosePct), Math.max(total - atClose, 0))
      : 0;

    return {
      total,
      atClose,
      afterClose,
      pending: Math.max(100 - total, 0)
    };
  }

  function segmentHtml(segment) {
    const tooltipAttribute = segment.tooltip
      ? ` data-tooltip="${escapeHtml(segment.tooltip)}" tabindex="0"`
      : '';
    const label = segment.label
      ? `<span class="progress-label">${escapeHtml(segment.label)}</span>`
      : '';
    const compactClass = segment.label && segment.width < 12 ? ' is-compact' : '';

    return `<span class="progress-segment ${segment.classes}${compactClass}" style="flex-basis: ${segment.width}%"${tooltipAttribute}>${label}</span>`;
  }

  function progressBarHtml(moduleName, breakdown, status) {
    const segments = [];

    if (breakdown.total === 0) {
      segments.push({
        classes: 'is-white is-first is-last',
        width: 100,
        label: '0%',
        tooltip: version === 'pro' ? 'Avance al cierre del módulo.' : 'Avance registrado en el módulo.'
      });
    } else {
      if (breakdown.atClose > 0) {
        segments.push({
          classes: `is-${status}`,
          width: breakdown.atClose,
          label: `${breakdown.atClose}%`,
          tooltip: version === 'pro' ? 'Avance al cierre del módulo.' : 'Avance registrado en el módulo.'
        });
      }

      if (version === 'pro' && breakdown.afterClose > 0) {
        segments.push({
          classes: 'is-late',
          width: breakdown.afterClose,
          label: `${breakdown.afterClose}%`,
          tooltip: 'Avance posterior al cierre del módulo.'
        });
      }

      if (breakdown.pending > 0) {
        segments.push({
          classes: 'is-pending',
          width: breakdown.pending,
          label: '',
          tooltip: ''
        });
      }

      if (segments.length) {
        segments[0].classes += ' is-first';
        segments[segments.length - 1].classes += ' is-last';
      }
    }

    const boundary = version === 'pro' && breakdown.afterClose > 0
      ? `<span class="progress-boundary" style="left: ${breakdown.atClose}%" aria-hidden="true"></span>`
      : '';
    const ariaLabel = version === 'pro'
      ? `${moduleName}: ${breakdown.atClose}% al cierre del módulo y ${breakdown.afterClose}% posterior al cierre.`
      : `${moduleName}: ${breakdown.total}% de avance registrado.`;

    return `
      <div class="progress-track" aria-label="${escapeHtml(ariaLabel)}">
        ${segments.map(segmentHtml).join('')}
        ${boundary}
      </div>
    `;
  }

  function renderIdentity(course, student) {
    courseTitle.textContent = course?.name || 'Curso';
    courseCode.textContent = `Código: ${course?.code || 'N/A'}`;
    studentName.textContent = student?.name || 'Alumno';
  }

  function renderModules(modules, student) {
    const moduleMap = new Map((student?.modules || []).map(item => [String(item.moduleId), item]));

    if (!modules.length) {
      moduleRows.innerHTML = '<tr><td colspan="3">No se encontraron módulos disponibles.</td></tr>';
      return;
    }

    moduleRows.innerHTML = modules.map(module => {
      const record = moduleMap.get(String(module.id));
      const breakdown = progressBreakdown(record);
      const visiblePercent = version === 'pro' ? breakdown.atClose : breakdown.total;
      const status = progressStatus(visiblePercent);
      const tooltip = version === 'pro' ? 'Avance al cierre del módulo.' : 'Avance registrado en el módulo.';

      return `
        <tr>
          <td>${escapeHtml(module.name)}</td>
          <td><span class="percent-pill is-${status}" data-tooltip="${tooltip}" tabindex="0">${visiblePercent}%</span></td>
          <td>${progressBarHtml(module.name, breakdown, status)}</td>
        </tr>
      `;
    }).join('');
  }

  function tooltipTargetFromEvent(event) {
    return event.target instanceof Element ? event.target.closest('[data-tooltip]') : null;
  }

  function showProgressTooltip(target) {
    const text = target.dataset.tooltip;
    if (!text) return;

    progressTooltip.textContent = text;
    progressTooltip.classList.add('is-visible');

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = progressTooltip.getBoundingClientRect();
    const left = Math.min(
      Math.max(targetRect.left + targetRect.width / 2, 16 + tooltipRect.width / 2),
      window.innerWidth - 16 - tooltipRect.width / 2
    );
    const preferredTop = targetRect.top - tooltipRect.height - 14;
    const top = preferredTop > 12 ? preferredTop : targetRect.bottom + 14;

    progressTooltip.style.left = `${left}px`;
    progressTooltip.style.top = `${top}px`;
  }

  function hideProgressTooltip() {
    progressTooltip.classList.remove('is-visible');
  }

  function setupTooltips() {
    document.addEventListener('mouseover', event => {
      const target = tooltipTargetFromEvent(event);
      if (target) showProgressTooltip(target);
    });

    document.addEventListener('mouseout', event => {
      const target = tooltipTargetFromEvent(event);
      if (target && !target.contains(event.relatedTarget)) hideProgressTooltip();
    });

    document.addEventListener('focusin', event => {
      const target = tooltipTargetFromEvent(event);
      if (target) showProgressTooltip(target);
    });

    document.addEventListener('focusout', hideProgressTooltip);
    window.addEventListener('scroll', hideProgressTooltip, true);
    window.addEventListener('resize', hideProgressTooltip);
  }

  function renderPhrase() {
    const todayKey = dayKeys[new Date().getDay()];
    phraseDay.textContent = dayLabels[todayKey];
    phraseText.textContent = motivationalPhrases[todayKey][0];
  }

  function renderLoading() {
    moduleRows.innerHTML = '<tr><td colspan="3">Cargando información de Canvas...</td></tr>';
  }

  function renderError(error) {
    moduleRows.innerHTML = `<tr><td colspan="3">${escapeHtml(error.message)}</td></tr>`;
  }

  async function initialize() {
    showReportLoader();
    setupTooltips();
    renderPhrase();
    renderLoading();

    try {
      if (!courseId) throw new Error('No se recibió course_id en la URL.');
      if (!userId) throw new Error('No se recibió user_id en la URL.');

      const query = new URLSearchParams({
        course_id: courseId,
        user_id: userId,
        role: 'student',
        version
      });
      const data = await fetchJson(`/api/report-data?${query.toString()}`);
      const student = (data.students || [])[0];

      if (!student) {
        throw new Error('No se encontraron datos de avance para este alumno.');
      }

      renderIdentity(data.course, student);
      renderModules(data.modules || [], student);
    } catch (error) {
      console.error(error);
      renderError(error);
    } finally {
      hideReportLoader();
    }
  }

  initialize();
})();
