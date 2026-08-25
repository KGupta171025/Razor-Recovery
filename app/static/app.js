let currentFilter = 'ALL';
let activeEntityId = null;
let activeEntityType = null;
let currentAuditTab = 'logs';
let isVoicePlaying = false;
let voicePlaybackInterval = null;
let activeOverride = 'normal';
let scorecardChart = null;

// XSS Prevention: HTML Sanitization Helper
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Page initialization
document.addEventListener('DOMContentLoaded', () => {
    initCanvasBackground();
    fetchMetrics();
    fetchPipelines();
    initScorecardChart();
    
    // Draw NOC SVG wires after a small delay to allow CSS layout to settle
    setTimeout(() => {
        drawNocWires();
    }, 500);

    // Start continuous automatic refresh polling every 3 seconds
    setInterval(() => {
        fetchMetrics();
        const modalOpen = document.getElementById('batch-modal').classList.contains('open');
        if (!modalOpen) {
            fetchPipelines();
            if (activeEntityId) {
                refreshAuditTrail(activeEntityId);
            }
        }
        drawNocWires();
    }, 3000);

    // Redraw SVG wires on window resize for responsiveness
    window.addEventListener('resize', drawNocWires);

    // AI Command Input key listener
    const aiInput = document.getElementById('ai-query-input');
    if (aiInput) {
        aiInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                executeAISearch();
            }
        });
    }
});

// Canvas Particle Network Background
function initCanvasBackground() {
    const canvas = document.getElementById('bg-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    let particles = [];
    const particleCount = 45;
    
    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
    
    class Particle {
        constructor() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.vx = (Math.random() - 0.5) * 0.4;
            this.vy = (Math.random() - 0.5) * 0.4;
            this.radius = Math.random() * 2 + 1;
        }
        
        update() {
            this.x += this.vx;
            this.y += this.vy;
            
            if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
            if (this.y < 0 || this.y > canvas.height) this.vy *= -1;
        }
        
        draw() {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
            ctx.fill();
        }
    }
    
    for (let i = 0; i < particleCount; i++) {
        particles.push(new Particle());
    }
    
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Draw links between close nodes
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dist = Math.hypot(particles[i].x - particles[j].x, particles[i].y - particles[j].y);
                if (dist < 180) {
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(59, 130, 246, ${0.1 * (1 - dist / 180)})`;
                    ctx.lineWidth = 0.8;
                    ctx.stroke();
                }
            }
        }
        
        particles.forEach(p => {
            p.update();
            p.draw();
        });
        
        requestAnimationFrame(animate);
    }
    
    animate();
}

// Fetch general dashboard metrics
function fetchMetrics() {
    fetch('/api/metrics')
        .then(res => res.json())
        .then(data => {
            document.getElementById('val-risk').innerText = `₹${data.total_at_risk.toLocaleString('en-IN')}`;
            document.getElementById('val-recovered').innerText = `₹${data.total_recovered.toLocaleString('en-IN')}`;
            document.getElementById('val-rate').innerText = `${data.recovery_rate}%`;
            document.getElementById('val-active').innerText = data.active_cases;
            
            // Sync selector state
            if (data.simulation_override) {
                activeOverride = data.simulation_override;
                document.getElementById('override-select').value = activeOverride;
            }
        })
        .catch(err => console.error('Error fetching metrics:', err));
}

// Draw dynamic network wires between Bank Gateways and Health Targets
function drawNocWires() {
    const svg = document.getElementById('svg-wires-container');
    if (!svg) return;
    svg.innerHTML = '';
    
    const svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0 || svgRect.height === 0) return;
    
    fetch('/api/gateway-health')
        .then(res => res.json())
        .then(healthData => {
            const banks = ['HDFC', 'ICICI', 'SBI', 'UPI'];
            banks.forEach(bank => {
                const bankNode = document.getElementById(`node-${bank.toLowerCase()}`);
                if (!bankNode) return;
                
                const bankRect = bankNode.getBoundingClientRect();
                const x1 = bankRect.right - svgRect.left;
                const y1 = bankRect.top + bankRect.height / 2 - svgRect.top;
                
                // Determine connection target based on health
                const health = healthData[bank];
                let targetText = 'Stable';
                
                // Style node elements in UI
                if (health === 'degraded') {
                    targetText = 'Degraded';
                    bankNode.className = 'node-bank active-degraded';
                } else {
                    bankNode.className = 'node-bank active-stable';
                }
                
                if (bank === 'UPI') {
                    // UPI connects specifically to the UPI rail outcome
                    targetText = 'UPI';
                }
                
                // Find matching health label target
                const targets = document.querySelectorAll('.health-target');
                let targetNode = null;
                targets.forEach(t => {
                    if (t.innerText.trim() === targetText) {
                        targetNode = t;
                    }
                });
                
                if (!targetNode) return;
                
                const targetRect = targetNode.getBoundingClientRect();
                const x2 = targetRect.left - svgRect.left;
                const y2 = targetRect.top + targetRect.height / 2 - svgRect.top;
                
                // Draw SVG path
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                const dx = Math.abs(x2 - x1) * 0.5;
                const d = `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
                path.setAttribute('d', d);
                
                let strokeColor = '#10b981'; // Green (Stable)
                if (health === 'degraded') strokeColor = '#ef4444'; // Red (Degraded)
                if (targetText === 'UPI') strokeColor = '#f59e0b'; // Yellow (UPI)
                
                path.setAttribute('stroke', strokeColor);
                path.setAttribute('stroke-width', '2');
                path.setAttribute('fill', 'none');
                path.setAttribute('style', `filter: drop-shadow(0 0 4px ${strokeColor}); opacity: 0.65;`);
                
                svg.appendChild(path);
            });
        })
        .catch(err => console.error('Error drawing wires:', err));
}

// Toggle Individual Bank Health Status
function toggleGatewayHealth(bank) {
    fetch('/api/gateway-health/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank: bank })
    })
    .then(res => res.json())
    .then(data => {
        showToast(`Bank gateway ${data.bank} toggled to ${data.health}.`, 'success');
        drawNocWires();
    })
    .catch(err => showToast('Failed to toggle bank health.', 'error'));
}

// Toggle All bank failures simulator switch
function toggleAllFailures(checkbox) {
    const targetOverride = checkbox.checked ? 'induce_gateway_failure' : 'normal';
    changeOverride(targetOverride);
}

// Set Active Simulation Override
function changeOverride(val) {
    fetch('/api/simulation/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ override: val })
    })
    .then(res => res.json())
    .then(data => {
        showToast(`Simulation Override set to: ${val}`, 'success');
        activeOverride = val;
        
        // Sync NOC failure toggle checkbox visual state
        const switchBtn = document.getElementById('noc-simulation-switch');
        if (switchBtn) {
            switchBtn.checked = (val === 'induce_gateway_failure');
        }
        
        drawNocWires();
        fetchMetrics();
    })
    .catch(err => showToast('Failed to change override state.', 'error'));
}

// Filter Pipeline list view
function filterPipeline(filter) {
    currentFilter = filter;
    
    // Toggle active button tab styles
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => {
        if (btn.innerText.includes('All') && filter === 'ALL' ||
            btn.innerText.includes('Payments') && filter === 'payment' ||
            btn.innerText.includes('Invoices') && filter === 'invoice' ||
            btn.innerText.includes('Recovered') && filter === 'RECOVERED') {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    
    fetchPipelines();
}

// Fetch pipelines cases data (supports natural language AI search 'q')
function fetchPipelines(searchQuery = '') {
    let url = '/api/pipelines';
    if (searchQuery && searchQuery.trim() !== '') {
        url += `?q=${encodeURIComponent(searchQuery)}`;
    }
    fetch(url)
        .then(res => res.json())
        .then(data => {
            const tbody = document.getElementById('pipeline-body');
            tbody.innerHTML = '';
            
            // Filter records
            const filtered = data.filter(item => {
                if (currentFilter === 'ALL') return true;
                if (currentFilter === 'RECOVERED') return item.stage === 'RECOVERED';
                return item.type === currentFilter;
            });
            
            filtered.forEach(item => {
                const tr = document.createElement('tr');
                tr.onclick = () => selectEntityRow(item.id, item.type, tr);
                if (activeEntityId === item.id) {
                    tr.className = 'active-row';
                }
                
                // Format Status Stages badges
                let stageClass = 'status-gated';
                if (item.stage === 'RECOVERED') stageClass = 'status-recovered';
                if (item.stage === 'STOPPED') stageClass = 'status-stopped';
                
                // Policy adherence status column check
                const isCompliant = item.stage !== 'STOPPED' || item.contact_count <= 3;
                const policyCol = isCompliant 
                    ? `<span class="compliance-badge-check"><i class="fa-solid fa-check"></i></span>`
                    : `<span class="compliance-badge-fail"><i class="fa-solid fa-triangle-exclamation"></i></span>`;

                tr.innerHTML = `
                    <td>
                        <strong style="display:block;">${escapeHTML(item.customer_name)}</strong>
                        <span style="font-size:10px; color:var(--text-dim);">${escapeHTML(item.id)}</span>
                    </td>
                    <td>₹${item.amount.toLocaleString('en-IN')}</td>
                    <td><span class="tag-reason">${escapeHTML(item.diagnose)}</span></td>
                    <td>${item.contact_count}/3</td>
                    <td><span class="gateway-status-tag ${stageClass}">${escapeHTML(item.stage)}</span></td>
                    <td style="text-align:center;">${policyCol}</td>
                `;
                tbody.appendChild(tr);
            });
        })
        .catch(err => console.error('Error fetching pipelines:', err));
}

// Row selector
function selectEntityRow(id, type, rowElement) {
    activeEntityId = id;
    activeEntityType = type;
    
    // Clear old active row selections
    const rows = document.querySelectorAll('.pipeline-table-v3 tbody tr');
    rows.forEach(r => r.classList.remove('active-row'));
    
    rowElement.classList.add('active-row');
    
    loadAuditTrail(id);
    loadAICopilotRecommendation(id);
}

// Fetch and populate AI Copilot Card
function loadAICopilotRecommendation(id) {
    const copilotCard = document.getElementById('copilot-card');
    const copilotBadge = document.getElementById('copilot-badge');
    const copilotBar = document.getElementById('copilot-bar');
    const copilotText = document.getElementById('copilot-text');
    const actionSlot = document.getElementById('copilot-action-slot');
    
    if (!copilotCard) return;
    
    fetch(`/api/ai/recommendation/${id}`)
        .then(res => res.json())
        .then(data => {
            copilotBadge.innerText = `Likelihood: ${data.probability}%`;
            copilotBar.style.width = `${data.probability}%`;
            
            // Adjust bar colors based on probability
            copilotBar.className = 'progress-fill';
            if (data.probability >= 80) {
                copilotBar.classList.add('fill-green');
            } else if (data.probability >= 50) {
                copilotBar.classList.add('fill-yellow');
            } else {
                copilotBar.classList.add('fill-red');
            }
            
            copilotText.innerText = data.reasoning;
            
            // Populate Action button
            actionSlot.innerHTML = '';
            if (data.recommended_action && data.recommended_action !== 'normal') {
                const btn = document.createElement('button');
                btn.className = 'btn btn-primary';
                btn.style.width = '100%';
                btn.style.fontSize = '11px';
                btn.style.padding = '6px 12px';
                btn.style.marginTop = '6px';
                btn.style.background = 'var(--accent-glow)';
                btn.style.borderColor = 'var(--accent-glow)';
                btn.innerHTML = `<i class="fa-solid fa-bolt"></i> Execute: ${escapeHTML(data.action_label)}`;
                btn.onclick = (e) => {
                    e.stopPropagation();
                    executeCopilotAction(id, data.recommended_action);
                };
                actionSlot.appendChild(btn);
            } else {
                actionSlot.innerHTML = `<div style="font-size:10px; color:var(--text-dim); text-align:center; padding: 4px 0;"><i class="fa-solid fa-circle-check"></i> Standard automated routing is optimal.</div>`;
            }
            
            copilotCard.style.display = 'block';
        })
        .catch(err => {
            console.error('Error loading AI recommendation:', err);
            copilotCard.style.display = 'none';
        });
}

// Execute AI suggested override actions
function executeCopilotAction(id, action) {
    const selector = document.getElementById('override-select');
    if (selector) {
        selector.value = action;
    }
    changeOverride(action);
    showToast(`AI Recommendation Executed: ${action.replace('_', ' ').toUpperCase()}`, 'success');
}

// AI Search Execution
function executeAISearch() {
    const input = document.getElementById('ai-query-input');
    const btn = document.getElementById('ai-query-btn');
    if (!input || !btn) return;
    
    const query = input.value.trim();
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...`;
    
    input.style.boxShadow = '0 0 10px rgba(59, 130, 246, 0.4)';
    
    fetchPipelines(query);
    
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-arrow-right"></i> Run AI`;
        input.style.boxShadow = 'none';
        if (query !== '') {
            showToast(`AI query applied: "${query}"`, 'info');
        }
    }, 600);
}

function suggestAIQuery(text) {
    const input = document.getElementById('ai-query-input');
    if (input) {
        input.value = text;
        executeAISearch();
    }
}

// Load collapsible Reasoning Audit Accordion
function loadAuditTrail(id) {
    fetch(`/api/audit/${id}`)
        .then(res => res.json())
        .then(data => {
            const root = document.getElementById('accordion-root');
            root.innerHTML = '';
            
            const logs = data.logs;
            const comms = data.communications;
            const entity = data.entity;
            
            // Build Collapsible Steps
            
            // 1. Data Input Step
            createAccordionItem(root, 'Data Input', `
                <div class="step-summary">Raw Ingested Transaction Payload</div>
                <div class="json-view-block">${JSON.stringify(entity, null, 2)}</div>
            `);
            
            // 2. Policy Check Step
            const contactLimitOk = entity.contact_count || entity.retry_count || 0;
            createAccordionItem(root, 'Policy Check', `
                <div class="policy-details">
                    <p><strong>Outreach Sequence:</strong> ${contactLimitOk} / 3 contact attempts.</p>
                    <p><strong>Compliance status:</strong> Gated and compliant under payment safety limits.</p>
                    <p><strong>Dunning Rules:</strong> Retries halted if dispute triggered or opt-out unsubscribe code parsed.</p>
                </div>
            `);
            
            // 3. Agent Decision (LLM)
            const strategy = entity.recovery_campaign_status || 'DIAGNOSING';
            createAccordionItem(root, 'Agent Decision (LLM)', `
                <p style="margin-bottom:6px;"><strong>Identified Strategy:</strong> ${escapeHTML(strategy)}</p>
                <div class="json-view-block">Prompt: Run failure diagnosis for ${escapeHTML(entity.id)}.
Outcome: Trigger collection campaign.</div>
            `);
            
            // 4. Action Taken (Email/Voice logs)
            let actionsContent = '<p>No outreach communication sent yet.</p>';
            if (comms.length > 0) {
                actionsContent = '<div class="communications-list" style="display:flex; flex-direction:column; gap:10px;">';
                comms.forEach(c => {
                    const dirIcon = c.direction === 'outbound' ? 'fa-paper-plane' : 'fa-reply';
                    const titleText = c.direction === 'outbound' ? 'Outbound Alert' : 'Customer Response';
                    
                    // Voice Call script parser
                    if (c.content.includes("AUDIO_CALL_TRANSCRIPT:")) {
                        const cleanScript = c.content.replace("AUDIO_CALL_TRANSCRIPT:", "");
                        
                        // Parse emotion and tags
                        let emotionClass = 'emotion-friendly';
                        let emotionName = 'Friendly/Empathy';
                        let phraseTags = '<span class="phrase-tag tag-ptp">PTP</span>';
                        
                        if (cleanScript.toLowerCase().includes("urgent") || cleanScript.toLowerCase().includes("warning")) {
                            emotionClass = 'emotion-urgent';
                            emotionName = 'Urgent/Firm';
                        }
                        
                        actionsContent += `
                            <div class="voice-simulator">
                                <div class="audio-player">
                                    <button class="audio-play-btn" onclick="toggleVoicePlayback(this)"><i class="fa-solid fa-play"></i></button>
                                    <div class="audio-wave-container">
                                        <div class="wave-bar"></div>
                                        <div class="wave-bar"></div>
                                        <div class="wave-bar"></div>
                                        <div class="wave-bar"></div>
                                        <div class="wave-bar"></div>
                                        <div class="wave-bar"></div>
                                        <div class="wave-bar"></div>
                                        <div class="wave-bar"></div>
                                    </div>
                                    <span class="audio-timer" id="voice-timer">00:00</span>
                                </div>
                                <div class="voice-emotion-indicator">
                                    <span class="emotion-label">Tone: ${escapeHTML(emotionName)}</span>
                                    <div class="emotion-color-bar ${escapeHTML(emotionClass)}"></div>
                                </div>
                                <div class="key-phrase-tags-row">
                                    ${phraseTags}
                                </div>
                                <div class="voice-transcript" id="voice-transcript-text">${escapeHTML(cleanScript)}</div>
                            </div>
                        `;
                    } else {
                        // Standard Email layout
                        actionsContent += `
                            <div class="comm-item" style="border:1px solid var(--card-border); padding:8px; border-radius:6px; background:rgba(0,0,0,0.15);">
                                <div style="font-size:10px; color:var(--text-muted); display:flex; justify-content:space-between; margin-bottom:4px;">
                                    <span><i class="fa-solid ${dirIcon}"></i> ${escapeHTML(titleText)} (${escapeHTML(c.channel)})</span>
                                    <span>${escapeHTML(new Date(c.timestamp).toLocaleTimeString())}</span>
                                </div>
                                <div class="comm-body" style="font-size:11px; white-space:pre-line;">${escapeHTML(c.content)}</div>
                            </div>
                        `;
                    }
                });
                actionsContent += '</div>';
            }
            
            // Check for Dispute Manual Intervention banner (HITL)
            const showHitl = entity.status === 'FAILED' && entity.recovery_campaign_status === 'PAUSED';
            if (showHitl) {
                root.insertAdjacentHTML('beforebegin', `
                    <div class="hitl-gate-panel" id="hitl-banner-gate">
                        <div class="hitl-warning-header">
                            <i class="fa-solid fa-triangle-exclamation"></i> Action Required: Dispute Active
                        </div>
                        <div class="hitl-details">
                            Buyer raised a claim. Campaign paused automatically to prevent harassment.
                        </div>
                        <div class="hitl-actions">
                            <button class="btn-hitl" id="hitl-btn-resolve" onclick="resolveHitlAction('${escapeHTML(entity.id)}', 'REFUND_RESOLVE')">Refund & Close</button>
                            <button class="btn-hitl" id="hitl-btn-extend" onclick="resolveHitlAction('${escapeHTML(entity.id)}', 'RESCHEDULE_PROMISE')">Extend 7 Days</button>
                        </div>
                    </div>
                `);
            } else {
                // Clear old banner
                const old = document.getElementById('hitl-banner-gate');
                if (old) old.remove();
            }

            createAccordionItem(root, 'Action Taken (Outreach)', actionsContent);
            
            // 5. Response/Result logs
            let logsHtml = '<ul style="list-style:none; padding-left:0; display:flex; flex-direction:column; gap:6px;">';
            logs.forEach(l => {
                logsHtml += `
                    <li style="border-bottom:1px solid rgba(255,255,255,0.03); padding-bottom:6px;">
                        <div style="font-size:10px; color:var(--text-dim);">${escapeHTML(new Date(l.timestamp).toLocaleTimeString())} - <strong>${escapeHTML(l.stage)}</strong></div>
                        <div style="font-weight:600; color:var(--text-muted); font-size:11px;">${escapeHTML(l.action_taken)}</div>
                        <div style="font-size:11px; color:var(--text-dim); margin-top:2px;">${escapeHTML(l.reasoning)}</div>
                    </li>
                `;
            });
            logsHtml += '</ul>';
            createAccordionItem(root, 'Response / Audit Result', logsHtml);
            
            // Open the first accordion step by default
            const firstHeader = root.querySelector('.accordion-header');
            if (firstHeader) toggleAccordion(firstHeader);
        })
        .catch(err => console.error('Error loading audit log:', err));
}

// Non-blocking refresh for active entity audit log during auto-polling
function refreshAuditTrail(id) {
    // Avoid redrawing while audio player is playing to prevent waveform interruption
    if (isVoicePlaying) return;
    
    fetch(`/api/audit/${id}`)
        .then(res => res.json())
        .then(data => {
            const entity = data.entity;
            const showHitl = entity.status === 'FAILED' && entity.recovery_campaign_status === 'PAUSED';
            
            const banner = document.getElementById('hitl-banner-gate');
            if (showHitl && !banner) {
                // Insert banner if missing
                const root = document.getElementById('accordion-root');
                root.insertAdjacentHTML('beforebegin', `
                    <div class="hitl-gate-panel" id="hitl-banner-gate">
                        <div class="hitl-warning-header">
                            <i class="fa-solid fa-triangle-exclamation"></i> Action Required: Dispute Active
                        </div>
                        <div class="hitl-details">
                            Buyer raised a claim. Campaign paused automatically to prevent harassment.
                        </div>
                        <div class="hitl-actions">
                            <button class="btn-hitl" id="hitl-btn-resolve" onclick="resolveHitlAction('${entity.id}', 'REFUND_RESOLVE')">Refund & Close</button>
                            <button class="btn-hitl" id="hitl-btn-extend" onclick="resolveHitlAction('${entity.id}', 'EXTEND_DEFER')">Extend 7 Days</button>
                        </div>
                    </div>
                `);
            } else if (!showHitl && banner) {
                banner.remove();
            }
        });
}

// Generate Accordion components
function createAccordionItem(container, title, content) {
    const item = document.createElement('div');
    item.className = 'accordion-item';
    
    const header = document.createElement('div');
    header.className = 'accordion-header';
    header.onclick = () => toggleAccordion(header);
    header.innerHTML = `
        <span>${title}</span>
        <i class="fa-solid fa-chevron-down accordion-icon"></i>
    `;
    
    const body = document.createElement('div');
    body.className = 'accordion-body';
    body.innerHTML = content;
    
    item.appendChild(header);
    item.appendChild(body);
    container.appendChild(item);
}

// Accordion open/close toggle
function toggleAccordion(header) {
    const item = header.parentElement;
    const body = item.querySelector('.accordion-body');
    const isActive = header.classList.contains('active-header');
    
    // Close other panels
    const allHeaders = header.parentElement.parentElement.querySelectorAll('.accordion-header');
    allHeaders.forEach(h => {
        h.classList.remove('active-header');
        h.parentElement.querySelector('.accordion-body').classList.remove('show-body');
    });
    
    if (!isActive) {
        header.classList.add('active-header');
        body.classList.add('show-body');
    }
}

// Action execution manual step
function stepEntityManual() {
    if (!activeEntityId) {
        showToast('Please select a payment or invoice case row first from the table list.', 'error');
        return;
    }
    
    fetch('/api/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: activeEntityType, entity_id: activeEntityId })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'gated_degraded') {
            showToast(`Retry halted! Gateway ${data.bank} is degraded. Pausing retry.`, 'error');
        } else if (data.status === 'recovered') {
            showToast(`Success! Recovered INR ${data.amount.toLocaleString('en-IN')}`, 'success');
        } else if (data.status === 'stopped') {
            showToast(`Campaign halted: ${data.message}`, 'error');
        } else {
            showToast(`Step processed: ${data.status}`, 'success');
        }
        
        fetchMetrics();
        fetchPipelines();
        loadAuditTrail(activeEntityId);
    })
    .catch(err => showToast('Failed to run simulator step.', 'error'));
}

// Trigger Batch Recovery Simulator
function triggerBatchRecovery() {
    document.getElementById('batch-trigger-view').style.display = 'none';
    document.getElementById('batch-loading-view').style.display = 'block';
    
    fetch('/api/run-batch', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
        document.getElementById('batch-loading-view').style.display = 'none';
        document.getElementById('batch-results-view').style.display = 'block';
        
        document.getElementById('res-total').innerText = data.total_records;
        document.getElementById('res-recovered').innerText = data.recovered_count;
        document.getElementById('res-amount').innerText = `₹${data.recovered_amount.toLocaleString('en-IN')}`;
        document.getElementById('res-rate').innerText = `${data.recovery_rate}%`;
        
        // Populate manual exceptions list
        const list = document.getElementById('res-exceptions');
        list.innerHTML = '';
        if (data.exceptions && data.exceptions.length > 0) {
            data.exceptions.forEach(e => {
                const li = document.createElement('li');
                li.innerHTML = `<strong>${e.id}</strong> - ${e.reason}`;
                list.appendChild(li);
            });
        } else {
            list.innerHTML = '<li>No unresolved manual escalations. All cases settled.</li>';
        }
        
        // Draw visual charts
        drawBatchCharts(data.recovered_count, data.total_records - data.recovered_count, data.stopped_count);
        fetchMetrics();
        fetchPipelines();
    })
    .catch(err => {
        document.getElementById('batch-loading-view').style.display = 'none';
        document.getElementById('batch-trigger-view').style.display = 'block';
        showToast('Batch execution simulation failed.', 'error');
    });
}

// Initialise scorecard performance timeline chart
function initScorecardChart() {
    const ctx = document.getElementById('scorecardLineChart');
    if (!ctx) return;
    
    scorecardChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Day 1', 'Day 2', 'Day 3', 'Day 4'],
            datasets: [
                {
                    label: 'Recovered Revenue',
                    data: [1.2, 3.4, 5.8, 7.2],
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.05)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                },
                {
                    label: 'Revenue at Risk',
                    data: [19.0, 16.5, 14.2, 11.8],
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.05)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: { display: true, grid: { display: false }, ticks: { color: '#64748b', font: { size: 8 } } },
                y: { display: false }
            }
        }
    });
}

// Draw double charts in batch results window
let doubleDoughnut = null;
let doubleLine = null;

function drawBatchCharts(recovered, failed, stopped) {
    const ctxDoughnut = document.getElementById('recoveryChart');
    const ctxLine = document.getElementById('timelineChart');
    
    if (doubleDoughnut) doubleDoughnut.destroy();
    if (doubleLine) doubleLine.destroy();
    
    doubleDoughnut = new Chart(ctxDoughnut, {
        type: 'doughnut',
        data: {
            labels: ['Recovered', 'In Progress', 'Stopped'],
            datasets: [{
                data: [recovered, failed, stopped],
                backgroundColor: ['#10b981', '#3b82f6', '#ef4444'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } }
        }
    });

    doubleLine = new Chart(ctxLine, {
        type: 'line',
        data: {
            labels: ['Round 1', 'Round 2', 'Round 3', 'Round 4'],
            datasets: [{
                label: 'Cumulative Cash Recovery (INR)',
                data: [
                    recovered * 8000, 
                    recovered * 14000, 
                    recovered * 21000, 
                    recovered * 26000
                ],
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.05)',
                borderWidth: 2,
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#64748b', font: { size: 9 } } },
                y: { ticks: { color: '#64748b', font: { size: 9 } } }
            }
        }
    });
}

// Reset Database and Seed fresh records
function triggerSeed() {
    fetch('/api/seed', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
        showToast('Database reset and seed data loaded successfully.', 'success');
        activeEntityId = null;
        activeEntityType = null;
        
        // Reset Accordion view to empty state
        const root = document.getElementById('accordion-root');
        root.innerHTML = `
            <div class="audit-placeholder" id="audit-empty-state">
                <i class="fa-solid fa-brain-circuit brain-icon"></i>
                <h3>Agent Evaluation Desk</h3>
                <p>Select any active case in the pipeline grid to trace the dynamic AI reasoning tree, policy checks, and Hinglish transcripts.</p>
            </div>
        `;
        
        fetchMetrics();
        fetchPipelines();
        drawNocWires();
    })
    .catch(err => showToast('Failed to seed mock data.', 'error'));
}

// Resolve Human manual action
function resolveHitlAction(id, actionType) {
    fetch('/api/dispute-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: id, action: actionType })
    })
    .then(res => res.json())
    .then(data => {
        showToast(data.message, 'success');
        fetchMetrics();
        fetchPipelines();
        loadAuditTrail(id);
    })
    .catch(err => showToast('Human action override failed.', 'error'));
}

// Playback voice transcription waveforms
function toggleVoicePlayback(btn) {
    const container = btn.parentElement;
    
    if (isVoicePlaying) {
        // Pause
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        container.classList.remove('wave-playing');
        clearInterval(voicePlaybackInterval);
        isVoicePlaying = false;
    } else {
        // Start play
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        container.classList.add('wave-playing');
        isVoicePlaying = true;
        
        let seconds = 0;
        const timerText = document.getElementById('voice-timer');
        
        voicePlaybackInterval = setInterval(() => {
            seconds++;
            const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
            const secs = (seconds % 60).toString().padStart(2, '0');
            timerText.innerText = `${mins}:${secs}`;
            
            // Limit fake audio playback to 15 seconds
            if (seconds >= 15) {
                btn.innerHTML = '<i class="fa-solid fa-play"></i>';
                container.classList.remove('wave-playing');
                clearInterval(voicePlaybackInterval);
                isVoicePlaying = false;
                timerText.innerText = '00:00';
            }
        }, 1000);
    }
}

// Modal Dialog Helpers
function openBatchModal() {
    document.getElementById('batch-modal').classList.add('open');
    document.getElementById('batch-results-view').style.display = 'none';
    document.getElementById('batch-loading-view').style.display = 'none';
    document.getElementById('batch-trigger-view').style.display = 'block';
}

function closeBatchModal() {
    document.getElementById('batch-modal').classList.remove('open');
}

// Toast alerts display helper
function showToast(msg, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.className = `toast show ${type}`;
    toast.innerText = msg;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3500);
}
