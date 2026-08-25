let currentFilter = 'ALL';
let activeEntityId = null;
let activeEntityType = null;
let currentAuditTab = 'logs';
let isVoicePlaying = false;
let voicePlaybackInterval = null;
let activeOverride = 'normal';
let scorecardChart = null;

// Global Notification Registry
let notificationsRegistry = [
    { timestamp: new Date(Date.now() - 7200000).toISOString(), title: "System Ready", msg: "Sliding rate limiter initialized. PII masking verified.", category: "security" },
    { timestamp: new Date(Date.now() - 5400000).toISOString(), title: "Database Integrity Check", msg: "SQLite foreign keys enforced successfully.", category: "database" },
    { timestamp: new Date(Date.now() - 2880000).toISOString(), title: "Mock Sandbox Ingested", msg: "Autonomic sandbox router mapped to memory databases.", category: "system" }
];

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

// GitHub Pages Autonomic Client-Side Simulation Sandbox Mode
const IS_GITHUB_PAGES = window.location.hostname.includes("github.io");

let mockPipelines = [];
let mockGatewayHealth = { "HDFC": "stable", "ICICI": "stable", "SBI": "stable", "UPI": "stable" };
let mockOverride = "normal";
let mockAuditLogs = {};

function initMockDatabase() {
    mockPipelines = [
        { id: "pay_failed_1001", type: "payment", name: "Customer (HDFC)", email: "rajesh@example.com", amount: 12500, status: "failed", stage: "INGESTED", contact_count: 0, reason: "Bank gateway response timeout" },
        { id: "pay_failed_1002", type: "payment", name: "Customer (ICICI)", email: "priya@example.com", amount: 48000, status: "failed", stage: "DIAGNOSED", contact_count: 0, reason: "Incorrect OTP entered by user" },
        { id: "inv_overdue_1003", type: "invoice", name: "Acme Enterprises", email: "billing@acme.com", amount: 145000, status: "PENDING", stage: "CHASING", contact_count: 1, reason: "B2B Overdue Invoice" },
        { id: "inv_overdue_1004", type: "invoice", name: "Karan Johar", email: "karan@dharmaprod.com", amount: 89000, status: "PENDING", stage: "GATED", contact_count: 2, reason: "Quiet Hours blackout window" },
        { id: "pay_failed_1005", type: "payment", name: "Customer (SBI)", email: "sanjay@example.com", amount: 9500, status: "captured", stage: "RECOVERED", contact_count: 1, reason: "Recovered via gateway switch" },
        { id: "inv_overdue_1006", type: "invoice", name: "Vijay Mallya", email: "vijay@kingfisher.com", amount: 250000, status: "FAILED", stage: "DISPUTED", contact_count: 1, reason: "Buyer raised billing dispute claim" }
    ];
    
    mockPipelines.forEach(item => {
        mockAuditLogs[item.id] = {
            entity: item,
            logs: [
                { timestamp: new Date(Date.now() - 3600000).toISOString(), stage: "INGESTED", action_taken: "Record Created", reasoning: "System detected payment/invoice event.", details: "" }
            ],
            communications: []
        };
        
        if (item.stage !== 'INGESTED') {
            mockAuditLogs[item.id].logs.push({
                timestamp: new Date(Date.now() - 1800000).toISOString(),
                stage: "DIAGNOSED",
                action_taken: "AI Failure Analysis",
                reasoning: item.reason,
                details: ""
            });
        }
        
        if (item.contact_count > 0) {
            mockAuditLogs[item.id].logs.push({
                timestamp: new Date(Date.now() - 900000).toISOString(),
                stage: "CHASING",
                action_taken: "Outreach Campaign Triggered",
                reasoning: `Initiated attempt ${item.contact_count}.`,
                details: ""
            });
            mockAuditLogs[item.id].communications.push({
                timestamp: new Date(Date.now() - 900000).toISOString(),
                channel: "email",
                direction: "outbound",
                content: `Dear ${item.name}, your checkout for INR ${item.amount} was interrupted. Please retry.`
            });
        }
        
        if (item.stage === 'DISPUTED') {
            mockAuditLogs[item.id].communications.push({
                timestamp: new Date(Date.now() - 300000).toISOString(),
                channel: "voice",
                direction: "inbound",
                content: "AUDIO_CALL_TRANSCRIPT: Urgent call from buyer. I dispute the billing amount of this purchase."
            });
        }
    });
}

if (IS_GITHUB_PAGES) {
    initMockDatabase();
}

function apiFetch(url, options = {}) {
    if (!IS_GITHUB_PAGES) {
        return window.fetch(url, options);
    }
    
    const parsedUrl = new URL(url, window.location.origin);
    const pathname = parsedUrl.pathname;
    
    let responseData = {};
    let statusCode = 200;
    
    if (pathname === '/api/metrics') {
        const atRisk = mockPipelines
            .filter(item => item.status !== 'captured' && item.status !== 'RECOVERED' && item.status !== 'CANCELLED')
            .reduce((sum, item) => sum + item.amount, 0);
        const recovered = mockPipelines
            .filter(item => item.status === 'captured' || item.status === 'RECOVERED')
            .reduce((sum, item) => sum + item.amount, 0);
        const recoveredCount = mockPipelines.filter(item => item.status === 'captured' || item.status === 'RECOVERED').length;
        
        responseData = {
            risk_amount: atRisk,
            recovered_amount: recovered,
            recovered_count: recoveredCount,
            total_cases: mockPipelines.length,
            stopped_cases: mockPipelines.filter(i => i.stage === 'STOPPED').length,
            disputed_cases: mockPipelines.filter(i => i.stage === 'DISPUTED').length,
            simulation_override: mockOverride
        };
    }
    
    else if (pathname === '/api/gateway-health') {
        responseData = mockGatewayHealth;
    }
    
    else if (pathname === '/api/gateway-health/toggle') {
        const body = JSON.parse(options.body || '{}');
        const bank = body.bank;
        if (bank && mockGatewayHealth[bank]) {
            mockGatewayHealth[bank] = mockGatewayHealth[bank] === 'stable' ? 'degraded' : 'stable';
        }
        responseData = { status: "success", gateway_health: mockGatewayHealth };
    }
    
    else if (pathname === '/api/simulation/override') {
        const body = JSON.parse(options.body || '{}');
        mockOverride = body.override || 'normal';
        
        if (mockOverride === "induce_gateway_failure") {
            Object.keys(mockGatewayHealth).forEach(k => mockGatewayHealth[k] = "degraded");
        } else if (mockOverride === "normal") {
            Object.keys(mockGatewayHealth).forEach(k => mockGatewayHealth[k] = "stable");
        }
        
        responseData = { status: "success", override: mockOverride };
    }
    
    else if (pathname === '/api/pipelines') {
        const q = parsedUrl.searchParams.get('q') || '';
        let filtered = [...mockPipelines];
        
        if (q.trim()) {
            const q_lower = q.toLowerCase();
            filtered = filtered.filter(item => {
                if (q_lower.includes("hdfc") && !item.name.toLowerCase().includes("hdfc")) return false;
                if (q_lower.includes("icici") && !item.name.toLowerCase().includes("icici")) return false;
                if (q_lower.includes("sbi") && !item.name.toLowerCase().includes("sbi")) return false;
                if (q_lower.includes("above") || q_lower.includes("over")) {
                    const match = q_lower.match(/\d+/);
                    if (match && item.amount <= parseInt(match[0])) return false;
                }
                return true;
            });
        }
        
        responseData = filtered.map(item => ({
            id: item.id,
            type: item.type,
            customer_name: item.name,
            amount: item.amount,
            diagnose: item.reason,
            contact_count: item.contact_count,
            stage: item.stage
        }));
    }
    
    else if (pathname.startsWith('/api/ai/recommendation/')) {
        const entityId = pathname.split('/').pop();
        const item = mockPipelines.find(i => i.id === entityId) || {};
        
        let probability = 85;
        let reasoning = "Transaction health is normal. Standard automated retry sequence is highly recommended.";
        let recommended_action = "normal";
        let action_label = "Proceed Sequence";
        
        if (item.stage === 'DISPUTED') {
            probability = 45;
            reasoning = "Customer raised a billing claim. High chargeback risk. Settle dispute or issue refund.";
            recommended_action = "dispute_trigger";
            action_label = "Refund & Close Case";
        } else if (item.stage === 'GATED') {
            probability = 60;
            reasoning = "Active bank gateway downtime detected on HDFC. Switch routing nodes.";
            recommended_action = "induce_gateway_failure";
            action_label = "Reroute Gateway Node";
        } else if (item.contact_count >= 2) {
            probability = 70;
            reasoning = "Multiple outreach attempts ignored. Settle dispute or mark opt-out.";
            recommended_action = "customer_opt_out";
            action_label = "Force Cancel Campaign";
        }
        
        responseData = { probability, reasoning, recommended_action, action_label };
    }
    
    else if (pathname.startsWith('/api/audit/')) {
        const entityId = pathname.split('/').pop();
        responseData = mockAuditLogs[entityId] || { logs: [], communications: [], entity: {} };
    }
    
    else if (pathname === '/api/step') {
        const body = JSON.parse(options.body || '{}');
        const entityId = body.entity_id;
        const item = mockPipelines.find(i => i.id === entityId);
        
        if (item) {
            if (item.stage === 'INGESTED') {
                item.stage = 'DIAGNOSED';
            } else if (item.stage === 'DIAGNOSED') {
                item.stage = 'CHASING';
                item.contact_count = Math.min(3, item.contact_count + 1);
            } else if (item.stage === 'CHASING') {
                if (item.contact_count >= 3) {
                    item.stage = 'STOPPED';
                    item.status = 'FAILED';
                } else if (mockOverride === 'customer_opt_out') {
                    item.stage = 'STOPPED';
                    item.status = 'FAILED';
                } else {
                    item.stage = 'RECOVERED';
                    item.status = 'captured';
                }
            }
            
            if (mockAuditLogs[item.id]) {
                mockAuditLogs[item.id].logs.push({
                    timestamp: new Date().toISOString(),
                    stage: item.stage,
                    action_taken: "Step Campaign Simulated",
                    reasoning: "Simulating campaign dunning progression inside browser.",
                    details: ""
                });
            }
        }
        responseData = { status: "success" };
    }
    
    else if (pathname === '/api/run-batch') {
        mockPipelines.forEach(item => {
            if (item.stage !== 'STOPPED' && item.stage !== 'RECOVERED') {
                item.stage = 'RECOVERED';
                item.status = 'captured';
            }
        });
        responseData = { status: "success", recovered_count: mockPipelines.length };
    }
    
    else if (pathname === '/api/seed') {
        initMockDatabase();
        responseData = { status: "success" };
    }
    
    else if (pathname === '/api/dispute-action') {
        const body = JSON.parse(options.body || '{}');
        const entityId = body.entity_id;
        const action = body.action;
        const item = mockPipelines.find(i => i.id === entityId);
        
        if (item) {
            if (action === 'REFUND_RESOLVE') {
                item.stage = 'STOPPED';
                item.status = 'CANCELLED';
            } else if (action === 'RESCHEDULE_PROMISE') {
                item.stage = 'GATED';
            }
        }
        responseData = { status: "success" };
    }
    
    return Promise.resolve({
        status: statusCode,
        ok: statusCode >= 200 && statusCode < 300,
        json: () => Promise.resolve(responseData)
    });
}

// Page initialization
document.addEventListener('DOMContentLoaded', () => {
    initCanvasBackground();
    loadSystemSettings();
    
    // URL routing query/hash check to open secret panel directly
    if (window.location.search.includes('manage=true') || window.location.hash.includes('manage') || window.location.pathname.includes('manage')) {
        openSecretPanel();
    }
    
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
    apiFetch('/api/metrics')
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
    
    apiFetch('/api/gateway-health')
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
    apiFetch('/api/gateway-health/toggle', {
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
    apiFetch('/api/simulation/override', {
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
    apiFetch(url)
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

                const isAlreadyMasked = item.customer_name.includes('*');
                const displayName = (isPIIDecrypted || isAlreadyMasked) ? item.customer_name : maskName(item.customer_name);

                tr.innerHTML = `
                    <td>
                        <strong style="display:block;">${escapeHTML(displayName)}</strong>
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
    
    apiFetch(`/api/ai/recommendation/${id}`)
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
    apiFetch(`/api/audit/${id}`)
        .then(res => res.json())
        .then(data => {
            const root = document.getElementById('accordion-root');
            root.innerHTML = '';
            
            const logs = data.logs;
            const comms = data.communications;
            const entity = data.entity;
            
            // Build Collapsible Steps
            
            // 1. Data Input Step
            let displayEntity = {...entity};
            if (!isPIIDecrypted) {
                if (displayEntity.name) displayEntity.name = maskName(displayEntity.name);
                if (displayEntity.email) displayEntity.email = maskEmail(displayEntity.email);
            }
            createAccordionItem(root, 'Data Input', `
                <div class="step-summary">Raw Ingested Transaction Payload</div>
                <div class="json-view-block">${JSON.stringify(displayEntity, null, 2)}</div>
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
                    
                    let rawContent = c.content;
                    if (!isPIIDecrypted) {
                        if (entity.email) rawContent = rawContent.replaceAll(entity.email, maskEmail(entity.email));
                        if (entity.name) rawContent = rawContent.replaceAll(entity.name, maskName(entity.name));
                    }
                    
                    // Voice Call script parser
                    if (rawContent.includes("AUDIO_CALL_TRANSCRIPT:")) {
                        const cleanScript = rawContent.replace("AUDIO_CALL_TRANSCRIPT:", "");
                        
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
                                <div class="comm-body" style="font-size:11px; white-space:pre-line;">${escapeHTML(rawContent)}</div>
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
    
    apiFetch(`/api/audit/${id}`)
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
    
    apiFetch('/api/step', {
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
    
    apiFetch('/api/run-batch', { method: 'POST' })
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
        
        // Push batch simulation notification
        notificationsRegistry.unshift({
            timestamp: new Date().toISOString(),
            title: "Simulation Batch Finished",
            msg: `Batch of ${data.total_records} records processed. Recovered ${data.recovered_count} cases.`,
            category: "simulation"
        });
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
    apiFetch('/api/seed', { method: 'POST' })
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
    apiFetch('/api/dispute-action', {
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

// Profile Modal Actions
function openProfileModal() {
    document.getElementById('profile-modal').classList.add('open');
}

function closeProfileModal() {
    document.getElementById('profile-modal').classList.remove('open');
}

function triggerProfileBackup() {
    showToast('Triggering database backup checkpoint...', 'info');
    
    apiFetch('/api/security/backup', { method: 'POST' })
    .then(res => {
        if (res.ok) {
            showToast('Backup completed successfully. razorrecovery_backup.db updated.', 'success');
            notificationsRegistry.unshift({
                timestamp: new Date().toISOString(),
                title: "Manual Backup Triggered",
                msg: "Database snapshot checkpoint saved successfully.",
                category: "database"
            });
        } else {
            showToast('Client-side simulated database snapshot created.', 'success');
            notificationsRegistry.unshift({
                timestamp: new Date().toISOString(),
                title: "Simulated Backup Saved",
                msg: "Mock sandbox environment database snapshot created.",
                category: "database"
            });
        }
    })
    .catch(() => {
        showToast('Client-side simulated database snapshot created.', 'success');
        notificationsRegistry.unshift({
            timestamp: new Date().toISOString(),
            title: "Simulated Backup Saved",
            msg: "Mock sandbox environment database snapshot created.",
            category: "database"
        });
    });
}

// Notifications Modal Actions
function openNotificationsModal() {
    renderNotifications();
    document.getElementById('notifications-modal').classList.add('open');
}

function closeNotificationsModal() {
    document.getElementById('notifications-modal').classList.remove('open');
}

function renderNotifications() {
    const list = document.getElementById('notifications-list');
    list.innerHTML = '';
    
    if (notificationsRegistry.length === 0) {
        list.innerHTML = '<p style="text-align:center; padding:20px; color:var(--text-muted);">No new notifications.</p>';
        return;
    }
    
    notificationsRegistry.forEach(n => {
        const date = new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const row = document.createElement('div');
        row.className = 'notification-row';
        row.innerHTML = `
            <div class="notification-meta">
                <span class="notification-time">${date}</span>
                <span class="notification-cat" style="text-transform:uppercase; font-size:9px; font-weight:700; color:var(--primary);">${n.category}</span>
            </div>
            <div class="notification-title">${escapeHTML(n.title)}</div>
            <div class="notification-msg">${escapeHTML(n.msg)}</div>
        `;
        list.appendChild(row);
    });
}

// Settings Modal Actions
function openSettingsModal() {
    loadSystemSettings();
    document.getElementById('settings-modal').classList.add('open');
}

// Persist closed trigger
function closeSettingsModal() {
    document.getElementById('settings-modal').classList.remove('open');
}

function saveSystemSettings() {
    const autoRec = document.getElementById('setting-auto-recovery').checked;
    const maxOut = document.getElementById('setting-max-outreach').value;
    const thresh = document.getElementById('setting-threshold').value;
    const piiStrat = document.getElementById('setting-pii-strategy').value;
    const backupInt = document.getElementById('setting-backup-interval').value;
    
    const settings = { autoRec, maxOut, thresh, piiStrat, backupInt };
    localStorage.setItem('razor_recovery_settings', JSON.stringify(settings));
    
    showToast('System preferences saved successfully.', 'success');
    notificationsRegistry.unshift({
        timestamp: new Date().toISOString(),
        title: "System Settings Updated",
        msg: "Dunning and compliance thresholds updated by administrator.",
        category: "system"
    });
    
    closeSettingsModal();
}

function loadSystemSettings() {
    const settingsStr = localStorage.getItem('razor_recovery_settings');
    if (!settingsStr) return;
    
    try {
        const settings = JSON.parse(settingsStr);
        document.getElementById('setting-auto-recovery').checked = settings.autoRec;
        document.getElementById('setting-max-outreach').value = settings.maxOut;
        document.getElementById('setting-threshold').value = settings.thresh;
        document.getElementById('val-setting-threshold').innerText = settings.thresh;
        document.getElementById('setting-pii-strategy').value = settings.piiStrat;
        document.getElementById('setting-backup-interval').value = settings.backupInt;
    } catch(e) {
        console.error('Failed to load local preferences:', e);
    }
}

// PII Masking/Unmasking Helper Drivers
let isPIIDecrypted = false;

function maskName(name) {
    if (!name) return "";
    const parts = name.split(" ");
    return parts.map(part => {
        if (part.length <= 2) return part;
        return part[0] + "*".repeat(part.length - 2) + part[part.length - 1];
    }).join(" ");
}

function maskEmail(email) {
    if (!email) return "";
    const parts = email.split("@");
    if (parts.length !== 2) return email;
    const name = parts[0];
    const domain = parts[1];
    if (name.length <= 2) return `**@${domain}`;
    return name[0] + "*".repeat(name.length - 2) + name[name.length - 1] + "@" + domain;
}

// Secret Panel Authentication & Control Room
let secretKeyBuffer = [];
const secretPhrase = "secret";

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    
    secretKeyBuffer.push(e.key.toLowerCase());
    if (secretKeyBuffer.length > secretPhrase.length) {
        secretKeyBuffer.shift();
    }
    
    if (secretKeyBuffer.join('') === secretPhrase) {
        secretKeyBuffer = [];
        openSecretPanel();
    }
});

function openSecretPanel() {
    document.getElementById('secret-id-input').value = '';
    document.getElementById('secret-pass-input').value = '';
    document.getElementById('secret-auth-card').style.display = 'block';
    document.getElementById('secret-console-card').style.display = 'none';
    
    document.getElementById('secret-override-hdfc').value = mockGatewayHealth['HDFC'] || 'stable';
    document.getElementById('secret-override-icici').value = mockGatewayHealth['ICICI'] || 'stable';
    document.getElementById('secret-override-sbi').value = mockGatewayHealth['SBI'] || 'stable';
    document.getElementById('secret-override-upi').value = mockGatewayHealth['UPI'] || 'stable';
    
    document.getElementById('secret-admin-modal').classList.add('open');
}

function closeSecretPanel() {
    document.getElementById('secret-admin-modal').classList.remove('open');
}

function authenticateSecretGate() {
    const id = document.getElementById('secret-id-input').value;
    const pass = document.getElementById('secret-pass-input').value;
    
    // Obscured via Base64 (RazorPay / RazorPay-Password)
    if (btoa(id) === "UmF6b3JQYXk=" && btoa(pass) === "UmF6b3JQYXktUGFzc3dvcmQ=") {
        showToast('Access Granted. Session unlocked.', 'success');
        document.getElementById('secret-auth-card').style.display = 'none';
        document.getElementById('secret-console-card').style.display = 'block';
        writeTerminalLog('root_authorization: valid credentials verified.');
        writeTerminalLog('gateway_map: routing maps loaded.');
    } else {
        showToast('Console Error: Invalid credentials.', 'error');
        writeTerminalLog('security_alert: invalid authentication attempt.');
    }
}

function writeTerminalLog(text) {
    const logs = document.getElementById('secret-terminal-logs');
    const timestamp = new Date().toLocaleTimeString();
    logs.innerHTML += `\n[${timestamp}] ${text}`;
    logs.scrollTop = logs.scrollHeight;
}

function applySecretGatewayOverride(bank, status) {
    writeTerminalLog(`overriding gateway: ${bank} -> ${status}`);
    mockGatewayHealth[bank] = status;
    
    if (!IS_GITHUB_PAGES) {
        apiFetch('/api/gateway-health/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bank: bank })
        })
        .then(() => {
            fetchMetrics();
            writeTerminalLog(`backend synced: ${bank} gateway updated.`);
        })
        .catch(err => {
            writeTerminalLog(`backend sync failed: ${err.message}`);
        });
    } else {
        fetchMetrics();
        writeTerminalLog(`sandbox synced: local NOC map refreshed.`);
    }
}

function triggerSecretCaseInjection() {
    const name = document.getElementById('secret-inject-name').value.trim();
    const email = document.getElementById('secret-inject-email').value.trim();
    const amountVal = document.getElementById('secret-inject-amount').value;
    const bank = document.getElementById('secret-inject-bank').value;
    
    if (!name || !email || !amountVal) {
        showToast('Console Error: Missing fields.', 'error');
        writeTerminalLog('case_injection_error: missing parameters.');
        return;
    }
    
    const amount = parseFloat(amountVal);
    if (isNaN(amount) || amount <= 0) {
        showToast('Console Error: Invalid amount.', 'error');
        writeTerminalLog('case_injection_error: amount must be a positive integer.');
        return;
    }
    
    const id = `pay_failed_${Math.floor(1000 + Math.random() * 9000)}`;
    const newCase = {
        id: id,
        type: "payment",
        name: name,
        email: email,
        amount: amount,
        status: "failed",
        stage: "INGESTED",
        contact_count: 0,
        reason: `${bank} outage forced by admin`
    };
    
    mockPipelines.unshift(newCase);
    mockAuditLogs[id] = {
        entity: newCase,
        logs: [
            { timestamp: new Date().toISOString(), stage: "INGESTED", action_taken: "Admin Force-Inject", reasoning: "Root injected simulated transaction.", details: "" }
        ],
        communications: []
    };
    
    writeTerminalLog(`injected transaction: id=${id}, customer=${name}, amount=${amount}`);
    showToast(`Simulated failure ${id} injected successfully!`, 'success');
    
    document.getElementById('secret-inject-name').value = '';
    document.getElementById('secret-inject-email').value = '';
    document.getElementById('secret-inject-amount').value = '';
    
    fetchMetrics();
    fetchPipelines();
}

function toggleSecretPIIDecryption() {
    isPIIDecrypted = !isPIIDecrypted;
    const badge = document.getElementById('decryption-status-badge');
    const btn = document.getElementById('btn-toggle-decryption');
    
    if (isPIIDecrypted) {
        badge.innerText = '[ACTIVE]';
        badge.className = 'decryption-active-alert';
        btn.innerText = 'Encrypt PII Stream';
        writeTerminalLog('security_compliance: PII masking disabled. Decryption active.');
        showToast('PII compliance disabled. Raw customer data exposed.', 'warning');
    } else {
        badge.innerText = '[INACTIVE]';
        badge.className = '';
        btn.innerText = 'Decrypt PII Stream';
        writeTerminalLog('security_compliance: PII masking active. Decryption disabled.');
        showToast('PII compliance enabled. Raw customer data masked.', 'success');
    }
    
    // Force re-render tables and details to reflect toggle
    fetchPipelines();
    if (activeEntityId) {
        loadAuditTrail(activeEntityId);
    }
}
