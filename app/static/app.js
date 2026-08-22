let currentFilter = 'ALL';
let activeEntityId = null;
let activeEntityType = null;
let currentAuditTab = 'logs';
let isVoicePlaying = false;
let voicePlaybackInterval = null;

// Page initialization
document.addEventListener('DOMContentLoaded', () => {
    initCanvasBackground();
    fetchMetrics();
    fetchPipelines();
    fetchGatewayHealth();
    checkApiStatus();

    // Start continuous automatic refresh polling every 3 seconds
    setInterval(() => {
        fetchMetrics();
        const modalOpen = document.getElementById('batch-modal').classList.contains('open');
        if (!modalOpen) {
            fetchPipelines();
            if (activeEntityId) {
                loadAuditTrail(activeEntityId);
            }
        }
        fetchGatewayHealth();
    }, 3000);
});

// Canvas Particle Network Background
function initCanvasBackground() {
    const canvas = document.getElementById('bg-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    let width = canvas.width = window.innerWidth;
    let height = canvas.height = window.innerHeight;
    
    window.addEventListener('resize', () => {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
    });
    
    const particles = [];
    const count = 45;
    
    for (let i = 0; i < count; i++) {
        particles.push({
            x: Math.random() * width,
            y: Math.random() * height,
            vx: (Math.random() - 0.5) * 0.4,
            vy: (Math.random() - 0.5) * 0.4,
            radius: Math.random() * 2 + 1
        });
    }
    
    function animate() {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.04)';
        
        for (let i = 0; i < count; i++) {
            const p = particles[i];
            p.x += p.vx;
            p.y += p.vy;
            
            if (p.x < 0 || p.x > width) p.vx *= -1;
            if (p.y < 0 || p.y > height) p.vy *= -1;
            
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            ctx.fill();
            
            for (let j = i + 1; j < count; j++) {
                const p2 = particles[j];
                const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
                if (dist < 180) {
                    ctx.beginPath();
                    ctx.moveTo(p.x, p.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                }
            }
        }
        requestAnimationFrame(animate);
    }
    animate();
}

// Toast notification helper
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.className = `toast show ${type}`;
    toast.innerText = message;
    
    setTimeout(() => {
        toast.className = 'toast';
    }, 3500);
}

// Check if API key is active
function checkApiStatus() {
    fetch('/api/metrics')
        .then(res => res.json())
        .then(() => {
            document.getElementById('api-mode').innerText = "LLM Engine: Ready (Active)";
        })
        .catch(() => {
            document.getElementById('api-mode').innerText = "LLM Engine: Connection Failed";
        });
}

// Fetch general metrics
function fetchMetrics() {
    fetch('/api/metrics')
        .then(res => res.json())
        .then(data => {
            document.getElementById('val-risk').innerText = `₹${data.total_at_risk.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            document.getElementById('val-recovered').innerText = `₹${data.total_recovered.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            document.getElementById('val-rate').innerText = `${data.recovery_rate}%`;
            document.getElementById('val-active').innerText = data.active_cases;
        })
        .catch(err => {
            console.error('Error fetching metrics:', err);
            showToast('Failed to fetch metrics summary.', 'error');
        });
}

// Fetch bank gateway statuses
function fetchGatewayHealth() {
    fetch('/api/gateway-health')
        .then(res => res.json())
        .then(data => {
            const list = document.getElementById('sidebar-gateway-list');
            list.innerHTML = '';
            
            for (const [bank, health] of Object.entries(data)) {
                const item = document.createElement('div');
                item.className = 'gateway-item';
                item.onclick = () => toggleGatewayHealth(bank);
                
                const isStable = health === 'stable';
                
                item.innerHTML = `
                    <div class="gateway-details">
                        <span class="gateway-name">${bank} Processor</span>
                    </div>
                    <span class="gateway-status-tag status-${health}">
                        ${health}
                    </span>
                `;
                list.appendChild(item);
            }
        })
        .catch(err => console.error('Error fetching NOC gateways:', err));
}

// Toggle Gateway Health
function toggleGatewayHealth(bank) {
    fetch('/api/gateway-health/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank: bank })
    })
    .then(res => res.json())
    .then(data => {
        showToast(`${bank} gateway set to ${data.health.toUpperCase()}`, data.health === 'stable' ? 'success' : 'error');
        fetchGatewayHealth();
        fetchPipelines();
    })
    .catch(err => console.error('Error toggling gateway:', err));
}

// Fetch cases pipeline
function fetchPipelines() {
    fetch('/api/pipelines')
        .then(res => res.json())
        .then(data => {
            renderPipeline(data);
        })
        .catch(err => {
            console.error('Error fetching pipeline:', err);
            showToast('Failed to fetch transaction pipeline.', 'error');
        });
}

// Render pipeline board
function renderPipeline(data) {
    const tbody = document.getElementById('pipeline-body');
    tbody.innerHTML = '';

    const filtered = data.filter(item => {
        if (currentFilter === 'ALL') return true;
        if (currentFilter === 'RECOVERED') return item.stage === 'RECOVERED';
        return item.type === currentFilter;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 32px;">No active pipelines found. Click 'Reset & Seed Data'.</td></tr>`;
        return;
    }

    filtered.forEach(item => {
        const row = document.createElement('tr');
        if (activeEntityId === item.id) {
            row.className = 'active-row';
        }
        
        row.onclick = () => selectEntity(item.id, item.type, item.stage);
        
        const isRecovered = item.stage === 'RECOVERED';
        const isStopped = item.stage === 'STOPPED' || item.stage === 'DISPUTED';

        row.innerHTML = `
            <td>
                <span class="cust-name">${item.name}</span>
                <span class="cust-id">${item.id}</span>
            </td>
            <td class="td-amount">₹${item.amount.toLocaleString('en-IN')}</td>
            <td>
                <div class="reason-tag">
                    <i class="fa-solid ${item.type === 'payment' ? 'fa-credit-card' : 'fa-file-invoice'}"></i>
                    <span>${item.reason}</span>
                </div>
            </td>
            <td class="td-contacts">${item.contact_count} / 3</td>
            <td>
                <span class="stage-badge stage-${item.stage.toLowerCase()}">
                    ${item.stage}
                </span>
            </td>
            <td>
                <div class="row-actions" onclick="event.stopPropagation()">
                    ${!isRecovered && !isStopped && item.stage !== 'GATED' ? `
                        <button class="action-icon-btn btn-step" title="Run AI Next Step" onclick="stepEntity('${item.type}', '${item.id}')">
                            <i class="fa-solid fa-play"></i>
                        </button>
                        <a href="/checkout/${item.id}" target="_blank" class="action-icon-btn btn-checkout" title="Open Simulated Checkout">
                            <i class="fa-solid fa-external-link"></i>
                        </a>
                    ` : `
                        <span style="color: var(--text-dim); font-size: 11px;">
                            ${item.stage === 'GATED' ? 'Gated (Wait)' : 'Resolved'}
                        </span>
                    `}
                </div>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// Select Filter tab
function filterPipeline(type) {
    currentFilter = type;
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.innerText.toLowerCase().includes(type.toLowerCase()) || 
            (type === 'ALL' && btn.innerText.includes('All')) ||
            (type === 'RECOVERED' && btn.innerText.includes('Recovered'))) {
            btn.classList.add('active');
        }
    });
    fetchPipelines();
}

// Select item to view Audit Trail
function selectEntity(id, type, stage) {
    activeEntityId = id;
    activeEntityType = type;
    
    // Highlights active row
    document.querySelectorAll('#pipeline-body tr').forEach(row => {
        const rowId = row.querySelector('.cust-id').innerText;
        if (rowId === id) {
            row.className = 'active-row';
        } else {
            row.className = '';
        }
    });

    document.getElementById('audit-empty-state').style.display = 'none';
    const content = document.getElementById('audit-content');
    content.style.display = 'flex';

    document.getElementById('audit-type').innerText = type.toUpperCase();
    document.getElementById('audit-entity-id').innerText = id;

    // Reset voice player state
    resetVoicePlayer();

    // Check HITL banner rules
    const hitl = document.getElementById('hitl-actions-container');
    const hitlMsg = document.getElementById('hitl-actions-message');
    if (stage === 'DISPUTED') {
        hitl.style.display = 'flex';
        hitlMsg.innerText = "Customer disputed the charge. Automated reminders paused pending manual merchant resolution.";
        document.getElementById('hitl-btn-resolve').style.display = 'block';
        document.getElementById('hitl-btn-extend').style.display = 'none';
    } else if (stage === 'GATED') {
        // Find if promise-to-pay
        hitl.style.display = 'flex';
        hitlMsg.innerText = "Active Promise-to-Pay registered. Reminders paused. You may manually extend this deadline by 7 days.";
        document.getElementById('hitl-btn-resolve').style.display = 'none';
        document.getElementById('hitl-btn-extend').style.display = 'block';
    } else {
        hitl.style.display = 'none';
    }

    loadAuditTrail(id);
    loadVoiceScript(id);
}

// Load Audit Trail details from API
function loadAuditTrail(id) {
    fetch(`/api/audit-trail/${id}`)
        .then(res => res.json())
        .then(data => {
            renderAuditTimeline(data.logs);
            renderAuditComms(data.communications);
        })
        .catch(err => {
            console.error('Error loading audit trail:', err);
            showToast('Failed to load audit logs.', 'error');
        });
}

// Render Audit timeline
function renderAuditTimeline(logs) {
    const timeline = document.getElementById('audit-timeline');
    timeline.innerHTML = '';

    if (logs.length === 0) {
        timeline.innerHTML = '<p style="color: var(--text-dim); font-size: 12px;">No audit logs yet.</p>';
        return;
    }

    logs.forEach(log => {
        const item = document.createElement('div');
        let markerClass = '';
        if (log.stage === 'RECOVERED') markerClass = 'recovered-marker';
        else if (log.stage === 'STOPPED') markerClass = 'stopped-marker';
        else if (log.stage === 'CHASING') markerClass = 'active-marker';
        else if (log.stage === 'GATED') markerClass = 'active-marker';

        item.className = `timeline-item ${markerClass}`;
        item.innerHTML = `
            <div class="timeline-marker"></div>
            <span class="timeline-time">${log.timestamp}</span>
            <div class="timeline-title">${log.action_taken} <span class="stage-badge stage-${log.stage.toLowerCase()}" style="font-size: 9px; padding: 2px 4px;">${log.stage}</span></div>
            ${log.reasoning ? `<div class="timeline-reasoning">${log.reasoning}</div>` : ''}
        `;
        timeline.appendChild(item);
    });
}

// Render communications outbox/inbox
function renderAuditComms(comms) {
    const list = document.getElementById('comms-list');
    list.innerHTML = '';

    if (comms.length === 0) {
        list.innerHTML = '<p style="color: var(--text-dim); font-size: 12px; text-align: center; padding: 20px;">No recovery messages sent or replies received yet.</p>';
        return;
    }

    comms.forEach(c => {
        const bubble = document.createElement('div');
        const isOut = c.direction === 'outbound';
        bubble.className = `comm-bubble ${isOut ? 'comm-outbound' : 'comm-inbound'}`;
        
        bubble.innerHTML = `
            <div class="comm-meta">
                <span>${isOut ? '📤 OUTGOING EMAIL' : '📥 CUSTOMER REPLY'}</span>
                <span>${c.timestamp}</span>
            </div>
            <div style="white-space: pre-line;">${c.content}</div>
        `;
        list.appendChild(bubble);
    });
}

// Load voice call script from API
function loadVoiceScript(id) {
    const transcriptText = document.getElementById('voice-transcript-text');
    transcriptText.innerHTML = '<p style="color: var(--text-dim);">Loading voice logs...</p>';
    
    fetch(`/api/voice-script/${id}`)
        .then(res => res.json())
        .then(data => {
            transcriptText.setAttribute('data-full-script', data.transcript);
            transcriptText.innerText = `Suggested Agent Next Step: ${data.suggested_next_step}\n\n[Click Play to listen and display the transcript]`;
        })
        .catch(err => {
            console.error('Error loading voice script:', err);
            transcriptText.innerText = "No Voice log available for this case stage.";
        });
}

// Toggle Voice call simulated playback
function toggleVoicePlayback() {
    const btn = document.getElementById('voice-play-btn');
    const wave = document.getElementById('audio-wave');
    const text = document.getElementById('voice-transcript-text');
    const timer = document.getElementById('voice-timer');
    
    const fullScript = text.getAttribute('data-full-script');
    if (!fullScript) return;

    if (isVoicePlaying) {
        // Pause
        resetVoicePlayer();
    } else {
        // Play
        isVoicePlaying = true;
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        wave.classList.add('wave-playing');
        text.innerText = '';
        
        let i = 0;
        let count = 0;
        
        voicePlaybackInterval = setInterval(() => {
            count++;
            let sec = count % 60;
            let min = Math.floor(count / 60);
            timer.innerText = `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
            
            // Incrementally show text characters
            if (i < fullScript.length) {
                text.innerText += fullScript.substring(i, i + 8);
                i += 8;
                text.scrollTop = text.scrollHeight;
            } else if (count > 25) {
                resetVoicePlayer();
            }
        }, 120);
    }
}

function resetVoicePlayer() {
    isVoicePlaying = false;
    if (voicePlaybackInterval) {
        clearInterval(voicePlaybackInterval);
        voicePlaybackInterval = null;
    }
    const btn = document.getElementById('voice-play-btn');
    if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
    const wave = document.getElementById('audio-wave');
    if (wave) wave.classList.remove('wave-playing');
    const timer = document.getElementById('voice-timer');
    if (timer) timer.innerText = '00:00';
}

// HITL resolve dispute refund
function resolveDisputeAction() {
    if (!confirm('Are you sure you want to issue a refund and resolve this dispute? This will cancel all collections.')) return;
    
    fetch('/api/dispute-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: activeEntityId, action: 'REFUND_RESOLVE' })
    })
    .then(res => res.json())
    .then(data => {
        showToast(data.message);
        closeAuditPanel();
        fetchMetrics();
        fetchPipelines();
    })
    .catch(err => console.error(err));
}

// HITL extend promise date
function extendPromiseAction() {
    fetch('/api/dispute-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: activeEntityId, action: 'RESCHEDULE_PROMISE' })
    })
    .then(res => res.json())
    .then(data => {
        showToast(data.message);
        selectEntity(activeEntityId, activeEntityType, 'GATED');
        fetchMetrics();
        fetchPipelines();
    })
    .catch(err => console.error(err));
}

// Switch between Audit tabs
function switchAuditTab(tab) {
    currentAuditTab = tab;
    document.querySelectorAll('.audit-tab').forEach(btn => {
        btn.classList.remove('active');
        if (btn.id === 'tab-voice-btn' && tab === 'voice') btn.classList.add('active');
        else if (btn.innerText.includes('Trail') && tab === 'logs') btn.classList.add('active');
        else if (btn.innerText.includes('Emails') && tab === 'comms') btn.classList.add('active');
    });

    document.getElementById('panel-logs').style.display = tab === 'logs' ? 'block' : 'none';
    document.getElementById('panel-comms').style.display = tab === 'comms' ? 'block' : 'none';
    document.getElementById('panel-voice').style.display = tab === 'voice' ? 'block' : 'none';
}

// Close audit side panel
function closeAuditPanel() {
    document.getElementById('audit-content').style.display = 'none';
    document.getElementById('audit-empty-state').style.display = 'flex';
    activeEntityId = null;
    activeEntityType = null;
    resetVoicePlayer();
    fetchPipelines();
}

// Run single step recovery
function stepEntity(type, id) {
    fetch('/api/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: type, entity_id: id })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'recovered') {
            showToast(`Case ${id} successfully recovered! Captured ₹${data.amount.toLocaleString('en-IN')}`, 'success');
        } else if (data.status === 'diagnosed') {
            showToast(`AI Diagnosis complete for ${id}. Recommended: ${data.strategy}`);
        } else if (data.status === 'stopped') {
            showToast(`Dunning campaign completed/halted for ${id}.`, 'error');
        } else if (data.status === 'gated_degraded') {
            showToast(`Retry deferred: ${data.bank} gateway is experiencing downtime.`, 'error');
        } else {
            showToast(`Execution tick processed for ${id}.`);
        }
        
        fetchMetrics();
        fetchPipelines();
        if (activeEntityId === id) {
            // Find stage from pipeline later or reload
            loadAuditTrail(id);
        }
    })
    .catch(err => {
        console.error('Error stepping recovery:', err);
        showToast('Error executing AI recovery step.', 'error');
    });
}

// Seed/Reset database
function triggerSeed() {
    if (!confirm('Are you sure you want to reset the database and seed fresh synthetic transactions?')) return;
    
    fetch('/api/seed', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            showToast(data.message);
            closeAuditPanel();
            fetchMetrics();
            fetchPipelines();
        })
        .catch(err => {
            console.error('Error seeding data:', err);
            showToast('Seeding failed.', 'error');
        });
}

// Modal controls
function openBatchModal() {
    document.getElementById('batch-modal').classList.add('open');
    document.getElementById('batch-trigger-view').style.display = 'block';
    document.getElementById('batch-loading-view').style.display = 'none';
    document.getElementById('batch-results-view').style.display = 'none';
}

function closeBatchModal() {
    document.getElementById('batch-modal').classList.remove('open');
    fetchMetrics();
    fetchPipelines();
}

// Trigger full batch simulation
function triggerBatchRecovery() {
    document.getElementById('batch-trigger-view').style.display = 'none';
    document.getElementById('batch-loading-view').style.display = 'block';

    fetch('/api/run-batch', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            document.getElementById('batch-loading-view').style.display = 'none';
            document.getElementById('batch-results-view').style.display = 'block';
            
            // Populate results
            document.getElementById('res-total').innerText = data.total_records;
            document.getElementById('res-recovered').innerText = data.recovered_count;
            document.getElementById('res-amount').innerText = `₹${data.recovered_amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            document.getElementById('res-rate').innerText = `${data.recovery_rate}%`;

            // Draw exceptions
            const excl = document.getElementById('res-exceptions');
            excl.innerHTML = '';
            if (data.exceptions.length === 0) {
                excl.innerHTML = '<li>None. All campaigns completed successfully or remain active.</li>';
            } else {
                data.exceptions.forEach(ex => {
                    const li = document.createElement('li');
                    li.innerText = ex;
                    excl.appendChild(li);
                });
            }

            // Draw Charts
            drawDoughnutChart(data.recovered_count, data.stopped_count, data.active_count);
            drawTimelineChart(data.recovered_amount);
            showToast('Batch simulation run completed.');
        })
        .catch(err => {
            console.error(err);
            showToast('Batch simulation failed.', 'error');
            openBatchModal();
        });
}

// Doughnut Chart recovery rate
function drawDoughnutChart(recovered, stopped, active) {
    const ctx = document.getElementById('recoveryChart').getContext('2d');
    if (window.myRecoveryChart) {
        window.myRecoveryChart.destroy();
    }
    
    window.myRecoveryChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Recovered', 'Stopped/Escalated', 'Active'],
            datasets: [{
                data: [recovered, stopped, active],
                backgroundColor: ['#10b981', '#ef4444', '#f59e0b'],
                borderWidth: 1,
                borderColor: '#1e293b'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            cutout: '70%'
        }
    });
}

// Cumulative Cash Timeline Line Chart
function drawTimelineChart(totalRecovered) {
    const ctx = document.getElementById('timelineChart').getContext('2d');
    if (window.myTimelineChart) {
        window.myTimelineChart.destroy();
    }

    // Generate cumulative recovery increments representing steps in the run
    const intervals = ['Round 1', 'Round 2', 'Round 3', 'Round 4'];
    const dataPoints = [
        totalRecovered * 0.40,
        totalRecovered * 0.70,
        totalRecovered * 0.90,
        totalRecovered
    ];

    window.myTimelineChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: intervals,
            datasets: [{
                label: 'Cash Recovered (INR)',
                data: dataPoints,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#3b82f6',
                pointRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8', font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8', font: { size: 9 }, callback: (v) => '₹' + (v/1000) + 'k' }
                }
            }
        }
    });
}
