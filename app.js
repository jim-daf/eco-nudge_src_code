/**
 * Eco-Nudge Negotiator - Main Application Logic
 * 
 * Handles:
 * - Navigation and view management
 * - Recipe rendering and analysis
 * - LLM integration (OpenAI API) with fallback mode
 * - Negotiation/suggestion engine
 * - Impact tracking and gamification
 * - User preferences and persistence
 */
const API_KEY = (typeof DEFAULT_API_KEY !== 'undefined') ? DEFAULT_API_KEY : '';
const App = (() => {
    // ===== State =====

    function getDefaultState() {
        return {
            currentView: 'recipes',
            currentRecipe: null,
            currentIngredients: [],
            openaiApiKey: API_KEY,
            model: 'gpt-4o',
            aiConnected: false,
            nudgeIntensity: 3,
            nudgeMode: 'proactive', // 'proactive' or 'reactive' - research IV (Nudge Delivery Mode)
            proactivenessLevel: 'medium', // 'low' | 'medium' | 'high' - sprint-2 proactiveness dial (only meaningful when nudgeMode === 'proactive')
            focusAreas: { carbon: true, health: true, cost: false },
            dietaryRestrictions: [],
            excludedFoods: [],
            allergies: '',
            impact: {
                totalCO2Saved: 0,
                mealsOptimized: 0,
                swapsMade: 0,
                streak: 0,
                lastActiveDate: null,
                history: [],
                weeklyData: [0, 0, 0, 0, 0, 0, 0],
            },
            chatHistory: [],
            recipeChatHistory: [],
            dismissedSuggestions: {}, // track user fatigue per ingredient
            userMood: 'neutral', // neutral, receptive, annoyed
            suggestionCount: 0,
            savedRecipes: [], // saved/modified recipes
            currentRecipeSaved: false, // track if current recipe has been saved
            appliedSwaps: [], // track inline swaps for undo: [{original, replacement, amount}]
        };
    }

    let state = getDefaultState();

    // ===== Dietary category → foods mapping =====
    const DIETARY_CATEGORY_FOODS = {
        'vegetarian': ['beef', 'lamb', 'pork', 'chicken', 'turkey', 'bacon', 'sausage', 'salami', 'ham', 'shrimp', 'prawns', 'salmon', 'tuna', 'cod', 'fish'],
        'vegan': ['beef', 'lamb', 'pork', 'chicken', 'turkey', 'bacon', 'sausage', 'salami', 'ham', 'shrimp', 'prawns', 'salmon', 'tuna', 'cod', 'fish', 'cheese', 'butter', 'cream', 'milk', 'yogurt', 'eggs', 'ice cream', 'honey'],
        'gluten-free': ['pasta', 'bread', 'wheat', 'flour', 'couscous', 'seitan'],
        'dairy-free': ['cheese', 'butter', 'cream', 'milk', 'yogurt', 'ice cream'],
        'nut-free': ['almonds', 'walnuts', 'cashews', 'peanuts', 'cashew cream', 'almond milk'],
    };

    // Returns all foods that should be excluded based on dietary checkboxes + explicit exclusions
    function getExcludedFoods() {
        const excluded = new Set(state.excludedFoods.map(f => f.toLowerCase()));
        state.dietaryRestrictions.forEach(restriction => {
            const foods = DIETARY_CATEGORY_FOODS[restriction.toLowerCase()];
            if (foods) {
                foods.forEach(f => excluded.add(f));
            }
        });
        return excluded;
    }

    // Check if a specific food/replacement is excluded
    function isFoodExcluded(foodName) {
        return getExcludedFoods().has(foodName.toLowerCase());
    }

    // ===== Nudge Delivery Mode Helpers (Research IV) =====
    // Grounded in Nudge Theory (Thaler & Sunstein, 2008), Proactive Decision Support
    // (Silver, 1991), Interruption & Attention in HCI (Bailey & Konstan, 2006).
    // Proactive: app pushes eco-info (auto-expand panels, color-coded scores, proactive chat, toasts).
    // Reactive: user must seek out eco-info (collapsed panels, plain scores, no proactive messaging).
    function isProactive() {
        return state.nudgeMode === 'proactive';
    }

    function isReactive() {
        return state.nudgeMode === 'reactive';
    }

    // ===== Proactiveness Level (Sprint 2) =====
    // Sprint-1 evidence: a single "always-on Pro" mode produced 8/14 distraction
    // complaints, RTLX 46, SUS 62 and a +275 s time gap. Sprint-2 splits Pro into
    // three opt-in stops so each user picks how much help they want:
    //   LOW    - 1 inline cue, 1-2 toasts, 1-2 AI bubbles, batched summary on save.
    //   MEDIUM - all med+high cues, pinned suggestion panel, 3-4 toasts/AI bubbles, no modal.
    //   HIGH   - sprint-1 Pro: modal pop-ups, impact strip, per-swap toasts.
    // Caller convention: levelAtLeast('medium') means "this fires at MEDIUM or HIGH".
    const LEVEL_ORDER = { low: 1, medium: 2, high: 3 };
    function getProactivenessLevel() {
        return state.proactivenessLevel || 'medium';
    }
    function levelAtLeast(level) {
        if (!isProactive()) return false;
        return LEVEL_ORDER[getProactivenessLevel()] >= LEVEL_ORDER[level];
    }
    function isLevel(level) {
        return isProactive() && getProactivenessLevel() === level;
    }

    // Per-session counters so LOW/MEDIUM can cap chatter at the levels the sketch promises.
    // Not persisted - reset on every page load.
    const _sessionLimits = { aiBubbles: 0, tipToasts: 0, milestonesShown: 0 };
    function aiBubbleBudgetExhausted() {
        if (!isProactive()) return true;
        const level = getProactivenessLevel();
        if (level === 'high') return false;
        const cap = level === 'low' ? 2 : 4;
        return _sessionLimits.aiBubbles >= cap;
    }
    function tipToastBudgetExhausted() {
        if (!isProactive()) return true;
        const level = getProactivenessLevel();
        if (level === 'high') return false;
        const cap = level === 'low' ? 2 : 4;
        return _sessionLimits.tipToasts >= cap;
    }



    // ===== Initialization =====
    function init() {
        // Parse research condition from URL (?condition=proactive or ?condition=reactive)
        const urlParams = new URLSearchParams(window.location.search);
        const conditionParam = urlParams.get('condition');
        if (conditionParam === 'proactive' || conditionParam === 'reactive') {
            state.nudgeMode = conditionParam;
            console.log('[Research] Nudge mode set from URL:', state.nudgeMode);
        }

        initTheme();
        setupLoginListeners();
        const savedUser = localStorage.getItem('econudge_user');
        const savedToken = localStorage.getItem('econudge_session_token');
        if (savedUser && savedToken) {
            // Validate session token with server
            fetch('/api/users/me', {
                headers: { 'Authorization': 'Bearer ' + savedToken }
            })
            .then(resp => {
                if (resp.ok) return resp.json();
                throw new Error('Session expired');
            })
            .then(data => {
                localStorage.setItem('econudge_user', JSON.stringify(data.user));
                onLoginSuccess(data.user);
            })
            .catch(() => {
                // Session invalid/expired - clear and show login
                localStorage.removeItem('econudge_user');
                localStorage.removeItem('econudge_session_token');
                showLoginScreen();
            });
        } else {
            localStorage.removeItem('econudge_user');
            localStorage.removeItem('econudge_session_token');
            showLoginScreen();
        }
    }

    function showLoginScreen() {
        const overlay = document.getElementById('loginOverlay');
        if (overlay) overlay.classList.remove('hidden');
    }

    function hideLoginScreen() {
        const overlay = document.getElementById('loginOverlay');
        if (overlay) overlay.classList.add('hidden');
    }

    let loginMode = 'login'; // 'login' or 'signup'

    function setupLoginListeners() {
        const loginBtn = document.getElementById('loginBtn');
        const loginInput = document.getElementById('loginUsername');
        const logoutBtn = document.getElementById('logoutBtn');
        const tabLogin = document.getElementById('tabLogin');
        const tabSignup = document.getElementById('tabSignup');

        if (loginBtn) loginBtn.addEventListener('click', handleLogin);
        if (loginInput) loginInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleLogin();
        });
        if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

        if (tabLogin) tabLogin.addEventListener('click', () => switchLoginTab('login'));
        if (tabSignup) tabSignup.addEventListener('click', () => switchLoginTab('signup'));
    }

    function switchLoginTab(mode) {
        loginMode = mode;
        const tabLogin = document.getElementById('tabLogin');
        const tabSignup = document.getElementById('tabSignup');
        const btn = document.getElementById('loginBtn');
        const errorEl = document.getElementById('loginError');
        if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
        if (mode === 'login') {
            tabLogin.classList.add('active');
            tabSignup.classList.remove('active');
            if (btn) btn.textContent = 'Log In';
        } else {
            tabLogin.classList.remove('active');
            tabSignup.classList.add('active');
            if (btn) btn.textContent = 'Sign Up';
        }
    }

    function showLoginError(msg) {
        const errorEl = document.getElementById('loginError');
        if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
    }

    async function handleLogin() {
        const input = document.getElementById('loginUsername');
        const passwordInput = document.getElementById('loginPassword');
        const username = (input.value || '').trim();
        const password = (passwordInput ? passwordInput.value : '') || '';

        if (username.length < 2) {
            showLoginError('Username must be at least 2 characters');
            return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
            showLoginError('Only letters, numbers, _ and - allowed');
            return;
        }
        if (password.length < 6) {
            showLoginError('Password must be at least 6 characters');
            return;
        }

        const endpoint = loginMode === 'signup' ? '/api/users/signup' : '/api/users/login';
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            if (!resp.ok) {
                let msg = 'Something went wrong';
                try { const err = await resp.json(); msg = err.error || msg; } catch (_) {}
                showLoginError(msg);
                return;
            }
            const data = await resp.json();
            if (data.ok) {
                localStorage.setItem('econudge_user', JSON.stringify(data.user));
                if (data.token) {
                    localStorage.setItem('econudge_session_token', data.token);
                }
                if (loginMode === 'signup') {
                    hideLoginScreen();
                    showOnboarding(data.user);
                } else {
                    onLoginSuccess(data.user);
                }
            } else {
                showLoginError(data.error || 'Something went wrong');
            }
        } catch (e) {
            showLoginError('Cannot connect to server. Please try again later.');
        }
    }

    function onLoginSuccess(user) {
        state.currentUser = user;
        hideLoginScreen();
        const greeting = document.getElementById('userGreeting');
        const displayName = document.getElementById('userDisplayName');
        const logoutBtn = document.getElementById('logoutBtn');
        if (greeting) greeting.style.display = '';
        if (displayName) displayName.textContent = user.display_name || user.username;
        if (logoutBtn) logoutBtn.style.display = '';

        // Personalize chat greeting (nudge-mode-aware)
        const chatGreeting = document.getElementById('chatGreetingText');
        if (chatGreeting) {
            const name = user.display_name || user.username;
            if (isProactive()) {
                chatGreeting.textContent = `Hey ${name}! I'm the Eco-Nudge assistant. I can look up recipe carbon footprints, suggest lower-impact swaps, help with meal planning, or answer questions about food sustainability. What are you cooking?`;
            } else {
                chatGreeting.textContent = `Hey ${name}! I'm here if you need me. Ask me anything about recipes or sustainable eating.`;
            }
        }

        // Now boot the rest of the app
        loadState();
        updateSystemPrompt();
        setupNavigation();
        setupEventListeners();
        renderRecipeGrid();
        renderSavedRecipesView();
        renderImpactView();
        updateStreakBadge();
        checkStreak();

        // Show researcher indicator if condition is set via URL
        showResearcherIndicator();

        // Proactive welcome nudge - surface a meaningful hook right after login.
        // Skip on LOW (reserves the tip-toast budget for in-context moments); fires on MEDIUM+ only.
        if (levelAtLeast('medium')) {
            setTimeout(() => {
                const name = user.display_name || user.username;
                const saved = state.impact.totalCO2Saved || 0;
                if (saved > 0) {
                    showToast(`👋 Welcome back, ${name}! You've saved ${saved.toFixed(2)} kg CO\u2082e so far - let's keep the streak going.`, 'info');
                } else {
                    showToast(`👋 Welcome, ${name}! Pick a recipe and I'll point out the high-impact ingredients for you.`, 'info');
                }
                _sessionLimits.tipToasts++;
            }, 600);
        }
    }

    function handleLogout() {
        const token = localStorage.getItem('econudge_session_token');
        if (token) {
            fetch('/api/users/logout', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token }
            }).catch(() => {}); // fire-and-forget
        }
        localStorage.removeItem('econudge_user');
        localStorage.removeItem('econudge_session_token');
        state = getDefaultState();
        const greeting = document.getElementById('userGreeting');
        const logoutBtn = document.getElementById('logoutBtn');
        if (greeting) greeting.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
        const input = document.getElementById('loginUsername');
        const passwordInput = document.getElementById('loginPassword');
        if (input) input.value = '';
        if (passwordInput) passwordInput.value = '';
        showLoginScreen();
    }

    // ===== Theme =====
    function initTheme() {
        const saved = localStorage.getItem('econudge_theme');
        if (saved === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    }

    function toggleTheme() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDark) {
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('econudge_theme', 'light');
        } else {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('econudge_theme', 'dark');
        }
    }

    // ===== State Persistence (per-user) =====
    function stateKey() {
        const user = state.currentUser;
        const uname = user ? user.username : '_anonymous';
        return `econudge_state_${uname}`;
    }

    function loadState() {
        try {
            const saved = localStorage.getItem(stateKey());
            if (saved) {
                const parsed = JSON.parse(saved);
                // Preserve currentUser from login, merge the rest
                const currentUser = state.currentUser;
                state = { ...state, ...parsed, currentUser };
            }
        } catch (e) {
            console.warn('Failed to load state:', e);
        }
        // Always enforce the correct model and API key - overrides stale localStorage values
        state.model = 'gpt-4o';
        state.openaiApiKey = API_KEY;
        // Preserve nudge mode set from URL param (don't let localStorage override it)
        const urlParams = new URLSearchParams(window.location.search);
        const condParam = urlParams.get('condition');
        if (condParam === 'proactive' || condParam === 'reactive') {
            state.nudgeMode = condParam;
        }
        checkAIConnection();
    }

    function saveState() {
        try {
            const toSave = { ...state };
            delete toSave.aiConnected; // Runtime-only flag
            delete toSave.openaiApiKey; // Always loaded from .env
            delete toSave.currentUser; // Stored separately
            localStorage.setItem(stateKey(), JSON.stringify(toSave));
        } catch (e) {
            console.warn('Failed to save state:', e);
        }
    }

    function openaiHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.openaiApiKey}`,
        };
    }

    async function checkAIConnection() {
        const statusEl = document.querySelector('.assistant-status');
        if (!state.openaiApiKey) {
            state.aiConnected = false;
            if (statusEl) statusEl.textContent = 'No API key. Add your OpenAI key in Settings';
            return;
        }
        try {
            const resp = await fetch('https://api.openai.com/v1/models', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${state.openaiApiKey}` },
            });
            if (resp.ok) {
                state.aiConnected = true;
                if (statusEl) statusEl.textContent = `Connected to OpenAI (${state.model})`;
            } else {
                state.aiConnected = false;
                if (statusEl) statusEl.textContent = 'API key invalid. Check Settings';
            }
        } catch (e) {
            state.aiConnected = false;
            if (statusEl) statusEl.textContent = 'OpenAI not reachable';
        }
    }

    // ===== Navigation =====
    function setupNavigation() {
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const view = link.dataset.view;
                switchView(view);
            });
        });

        const navBrandLink = document.getElementById('navBrandLink');
        if (navBrandLink) {
            navBrandLink.addEventListener('click', (e) => {
                e.preventDefault();
                switchView('recipes');
            });
        }
    }

    // Pending navigation target when save-before-leaving dialog is shown
    let pendingNavView = null;

    function switchView(viewName) {
        // Intercept navigation away from detail view if recipe not saved
        if (state.currentView === 'detail' && viewName !== 'detail' && state.currentRecipe && !state.currentRecipeSaved) {
            pendingNavView = viewName;
            document.getElementById('saveBeforeLeavingOverlay').classList.add('active');
            return;
        }

        // Clean up detail view state when navigating away
        if (state.currentView === 'detail' && viewName !== 'detail') {
            hideRecipeNavLink();
            state.currentRecipe = null;
            state.currentIngredients = [];
            state.currentRecipeSaved = false;
        }

        performSwitchView(viewName);
    }

    function performSwitchView(viewName) {
        state.currentView = viewName;

        // Update nav links
        document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
        const activeLink = document.querySelector(`[data-view="${viewName}"]`);
        if (activeLink) activeLink.classList.add('active');

        // Update views
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const activeView = document.getElementById(`view-${viewName}`);
        if (activeView) activeView.classList.add('active');

        // Proactive: contextual nudge per destination view.
        if (isProactive()) triggerProactiveViewNudge(viewName);
    }

    // Proactive nudges that fire when entering a top-level view.
    // Throttled per-view so participants aren't spammed if they bounce between tabs.
    const _proactiveViewNudgeTimes = {};
    function triggerProactiveViewNudge(viewName) {
        // LOW level keeps view changes silent - view-entry nudges are background chatter
        // that the sketch reserves for MEDIUM+ (LOW's budget is spent on in-recipe cues).
        if (isLevel('low')) return;
        if (tipToastBudgetExhausted()) return;
        const now = Date.now();
        const last = _proactiveViewNudgeTimes[viewName] || 0;
        if (now - last < 30000) return; // 30s cool-down per view
        _proactiveViewNudgeTimes[viewName] = now;

        if (viewName === 'impact') {
            const saved = state.impact.totalCO2Saved || 0;
            const swaps = state.impact.swapsMade || 0;
            const streak = state.impact.streak || 0;
            setTimeout(() => {
                _sessionLimits.tipToasts++;
                if (swaps === 0) {
                    showToast(`📊 No eco-swaps yet - open any recipe and try the green swap suggestions to start your impact log.`, 'info');
                } else if (streak >= 3) {
                    showToast(`🔥 ${streak}-day streak! You've cut ${saved.toFixed(2)} kg CO\u2082e - keep it rolling today.`, 'success');
                } else {
                    showToast(`🌱 ${swaps} swap${swaps === 1 ? '' : 's'} so far, saving ${saved.toFixed(2)} kg CO\u2082e. One more today bumps your streak!`, 'info');
                }
            }, 400);
        } else if (viewName === 'saved') {
            setTimeout(() => {
                const recipes = state.savedRecipes || [];
                if (recipes.length === 0) return;
                const highImpact = recipes.filter(r => {
                    const total = EcoData.calculateRecipeCO2(r.ingredients);
                    return (total / r.servings) >= 3;
                });
                if (highImpact.length > 0) {
                    const name = highImpact[0].name;
                    _sessionLimits.tipToasts++;
                    showToast(`💡 "${name}" is one of your higher-carbon saves - open it and I'll suggest swaps.`, 'warning');
                }
            }, 400);
        } else if (viewName === 'recipes') {
            // Only nudge on the very first visit per session, after data is rendered.
            if (_proactiveViewNudgeTimes['__recipesGreeted']) return;
            _proactiveViewNudgeTimes['__recipesGreeted'] = now;
            setTimeout(() => {
                _sessionLimits.tipToasts++;
                showToast(`🌍 Tip: cards with a red glow are above-average impact - great candidates for swaps.`, 'info');
            }, 1200);
        }
    }

    function navigateAwayFromDetail(targetView) {
        if (state.currentRecipe && !state.currentRecipeSaved) {
            pendingNavView = targetView;
            document.getElementById('saveBeforeLeavingOverlay').classList.add('active');
            return;
        }
        completeNavAway(targetView);
    }

    function completeNavAway(targetView) {
        performSwitchView(targetView);
        hideRecipeNavLink();
        state.currentRecipe = null;
        state.currentIngredients = [];
        state.currentRecipeSaved = false;
    }

    // ===== Event Listeners =====
    function setupEventListeners() {
        // Theme toggle
        document.getElementById('themeToggle').addEventListener('click', toggleTheme);

        // Back button
        document.getElementById('backToRecipes').addEventListener('click', () => {
            navigateAwayFromDetail('recipes');
        });

        // Save before leaving dialog buttons
        document.getElementById('saveBeforeLeavingYes').addEventListener('click', () => {
            saveCurrentRecipe();
            document.getElementById('saveBeforeLeavingOverlay').classList.remove('active');
            completeNavAway(pendingNavView || 'recipes');
            pendingNavView = null;
        });
        document.getElementById('saveBeforeLeavingNo').addEventListener('click', () => {
            document.getElementById('saveBeforeLeavingOverlay').classList.remove('active');
            completeNavAway(pendingNavView || 'recipes');
            pendingNavView = null;
        });

        // Analyze custom recipe
        document.getElementById('analyzeCustomBtn').addEventListener('click', analyzeCustomRecipe);

        // Add Recipe dialog open/close
        document.getElementById('addRecipeBtn').addEventListener('click', openAddRecipeDialog);
        document.getElementById('addRecipeClose').addEventListener('click', closeAddRecipeDialog);
        document.getElementById('addRecipeCancelBtn').addEventListener('click', closeAddRecipeDialog);
        document.getElementById('addRecipeOverlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeAddRecipeDialog();
        });

        // Apply/dismiss all
        document.getElementById('applyAllBtn').addEventListener('click', applyAllSuggestions);
        document.getElementById('dismissAllBtn').addEventListener('click', dismissAllSuggestions);

        // AI swap suggestions
        document.getElementById('aiSuggestBtn').addEventListener('click', fetchAISwapSuggestions);

        // Main chat (popup)
        document.getElementById('mainChatSend').addEventListener('click', sendMainChat);
        document.getElementById('mainChatInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendMainChat();
        });

        // Chatbot popup toggle
        document.getElementById('chatbotFab').addEventListener('click', toggleChatbotPopup);
        document.getElementById('chatbotPopupClose').addEventListener('click', closeChatbotPopup);

        // Save recipe
        document.getElementById('saveRecipeBtn').addEventListener('click', saveCurrentRecipe);

        // Slideshow navigation
        document.getElementById('slideshowPrev')?.addEventListener('click', slideshowPrev);
        document.getElementById('slideshowNext')?.addEventListener('click', slideshowNext);

        // Settings
        document.getElementById('saveFocusAreas')?.addEventListener('click', saveFocusAreas);
        document.getElementById('addExcludeFoodBtn')?.addEventListener('click', addExcludedFood);
        document.getElementById('excludeFoodInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addExcludedFood();
        });
        // Dietary restriction checkboxes - save immediately on toggle
        ['dietVegetarian', 'dietVegan', 'dietGlutenFree', 'dietDairyFree', 'dietNutFree'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', saveDietaryCheckboxes);
        });
        document.getElementById('saveApiKeyBtn')?.addEventListener('click', saveApiKey);
        document.getElementById('clearDataBtn')?.addEventListener('click', clearAllData);

        // Proactiveness-level dial (sprint 2): three buttons act as a single radio group.
        document.querySelectorAll('#proactivenessLevelCard .level-option').forEach(btn => {
            btn.addEventListener('click', () => setProactivenessLevel(btn.dataset.level));
        });

        // Load settings into form
        loadSettingsToForm();
    }

    // ===== Recipe Grid =====
    function renderRecipeGrid() {
        const grid = document.getElementById('recipeGrid');
        grid.innerHTML = '';

        const excluded = getExcludedFoods();

        // Filter out recipes that contain any excluded ingredient
        const filteredRecipes = EcoData.sampleRecipes.filter(recipe => {
            return !recipe.ingredients.some(ing => excluded.has(ing.name.toLowerCase()));
        });

        if (filteredRecipes.length === 0) {
            grid.innerHTML = `
                <div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--text-secondary);">
                    <p style="font-size:1.5rem;margin-bottom:0.5rem;">🥗</p>
                    <p>No recipes match your current dietary preferences. Try adjusting your settings or add a custom recipe below!</p>
                </div>
            `;
            return;
        }

        filteredRecipes.forEach(recipe => {
            const totalCO2 = EcoData.calculateRecipeCO2(recipe.ingredients);
            const perServing = totalCO2 / recipe.servings;
            const rating = EcoData.getCarbonRating(perServing);
            const rawSubstitutable = EcoData.findSubstitutableIngredients(recipe.ingredients);
            // Filter alternatives by exclusions
            const substitutable = rawSubstitutable
                .map(sub => ({
                    ...sub,
                    alternatives: sub.alternatives.filter(alt => !excluded.has(alt.replacement.toLowerCase()))
                }))
                .filter(sub => sub.alternatives.length > 0);

            const ingredientNames = recipe.ingredients.map(i => {
                const isSub = substitutable.find(s => s.ingredient === i.name.toLowerCase());
                if (isSub) {
                    return `<span class="highlight-ingredient">${i.name}</span>`;
                }
                return i.name;
            }).join(', ');

            // Proactive: visually flag high-impact recipe cards in the grid so
            // participants notice them before clicking, plus a celebratory tag
            // for low-impact picks. Reactive mode leaves cards visually neutral.
            let proactiveCardClass = '';
            let proactiveBadge = '';
            if (isProactive()) {
                if (perServing >= 3) {
                    proactiveCardClass = ' recipe-card-high-impact';
                    proactiveBadge = `<span class="recipe-impact-badge impact-high" title="Above-average carbon footprint">⚠️ High impact</span>`;
                } else if (perServing >= 1.5) {
                    proactiveCardClass = ' recipe-card-medium-impact';
                    proactiveBadge = `<span class="recipe-impact-badge impact-medium" title="Moderate carbon footprint">⚡ Medium impact</span>`;
                } else {
                    proactiveCardClass = ' recipe-card-low-impact';
                    proactiveBadge = `<span class="recipe-impact-badge impact-low" title="Low carbon footprint">🌿 Low impact</span>`;
                }
            }

            const card = document.createElement('div');
            card.className = 'recipe-card' + proactiveCardClass;
            card.innerHTML = `
                ${recipe.image ? `<div class="recipe-card-image"><img src="${recipe.image}" alt="${recipe.name}" loading="lazy"></div>` : ''}
                <div class="recipe-card-body">
                    <div class="recipe-card-header">
                        <h3>${recipe.name}</h3>
                        ${proactiveBadge}
                    </div>
                    <div class="recipe-card-meta">
                        <span>🍽️ ${recipe.servings} servings</span>
                        <span>⏱️ ${recipe.time}</span>
                        <span>🌍 ${recipe.cuisine}</span>
                    </div>
                    <div class="recipe-card-ingredients">${ingredientNames}</div>
                    <div class="recipe-card-footer">
                        <span class="co2-mini">🌿 ${perServing.toFixed(2)} kg CO₂e/serving</span>
                        ${substitutable.length > 0 ? `<span class="text-green text-sm font-bold">${substitutable.length} swap${substitutable.length > 1 ? 's' : ''} available</span>` : '<span class="text-green text-sm">Already eco-friendly!</span>'}
                    </div>
                </div>
            `;
            card.addEventListener('click', () => openRecipeDetail(recipe));
            grid.appendChild(card);
        });

        // Reset slideshow and show first page
        slideshowPage = 0;
        updateSlideshow();
    }

    // ===== Recipe Slideshow =====
    var slideshowPage = 0;
    var CARDS_PER_SLIDE = 6;

    function getTotalSlideshowPages() {
        const track = document.getElementById('recipeGrid');
        if (!track) return 1;
        const total = track.children.length;
        return Math.max(1, Math.ceil(total / CARDS_PER_SLIDE));
    }

    function updateSlideshow() {
        const track = document.getElementById('recipeGrid');
        const prevBtn = document.getElementById('slideshowPrev');
        const nextBtn = document.getElementById('slideshowNext');
        if (!track) return;

        const totalCards = track.children.length;
        const totalPages = getTotalSlideshowPages();
        if (slideshowPage >= totalPages) slideshowPage = totalPages - 1;
        if (slideshowPage < 0) slideshowPage = 0;

        // Show/hide cards for the current page
        const start = slideshowPage * CARDS_PER_SLIDE;
        const end = start + CARDS_PER_SLIDE;
        Array.from(track.children).forEach((card, i) => {
            card.style.display = (i >= start && i < end) ? '' : 'none';
        });

        if (prevBtn) prevBtn.disabled = (slideshowPage === 0);
        if (nextBtn) nextBtn.disabled = (slideshowPage >= totalPages - 1);

        // Render page dots
        const dotsContainer = document.getElementById('slideshowDots');
        if (dotsContainer) {
            dotsContainer.innerHTML = '';
            for (let p = 0; p < totalPages; p++) {
                const dot = document.createElement('button');
                dot.className = 'slideshow-dot' + (p === slideshowPage ? ' active' : '');
                dot.title = 'Page ' + (p + 1);
                dot.addEventListener('click', () => { slideshowPage = p; updateSlideshow(); });
                dotsContainer.appendChild(dot);
            }
        }
    }

    function slideshowPrev() { slideshowPage--; updateSlideshow(); }
    function slideshowNext() { slideshowPage++; updateSlideshow(); }

    // ===== Recipe Detail =====
    function openRecipeDetail(recipe) {
        state.currentRecipe = recipe;
        state.currentIngredients = [...recipe.ingredients];
        state.recipeChatHistory = [];
        state.suggestionCount = 0;
        state.currentRecipeOptimized = false;
        state.currentRecipeSaved = false;
        state.appliedSwaps = [];

        renderDetailView();
        switchView('detail');
        showRecipeNavLink(recipe.name);

        // ===== Proactive nudge behaviors =====
        if (isProactive()) {
            const totalCO2 = EcoData.calculateRecipeCO2(recipe.ingredients);
            const perServing = totalCO2 / recipe.servings;

            // Proactive toast for high-impact recipes - fires at every level but counts
            // against LOW/MEDIUM's session budget so it can't fire repeatedly.
            if (perServing >= 2 && !tipToastBudgetExhausted()) {
                setTimeout(() => {
                    _sessionLimits.tipToasts++;
                    showToast(`🌍 This recipe produces ${totalCO2.toFixed(1)} kg CO₂e - that's ${perServing.toFixed(1)} kg/serving. Check the eco-suggestions panel!`, 'warning');
                }, 800);
            }

            // Proactive chat message - AI initiates conversation about this recipe.
            // Counts against the AI-bubble budget for LOW/MEDIUM (HIGH is uncapped).
            const highImpactIngredients = recipe.ingredients
                .filter(i => (EcoData.carbonFootprint[i.name.toLowerCase()] || 1) >= 10)
                .map(i => i.name);

            if (highImpactIngredients.length > 0 && !aiBubbleBudgetExhausted()) {
                setTimeout(() => {
                    _sessionLimits.aiBubbles++;
                    const proactiveMsg = `I notice this recipe uses **${highImpactIngredients.join(', ')}** - ${highImpactIngredients.length > 1 ? 'these are' : 'that\'s'} among the highest-carbon ingredients. Want me to suggest some lower-impact alternatives that still taste great?`;
                    appendChatMessage('mainChatMessages', 'assistant', proactiveMsg);
                    state.chatHistory.push({ role: 'assistant', content: proactiveMsg });
                    // Auto-open the chat popup only at MEDIUM+. LOW posts the message but
                    // lets the user choose to open the chat (matches the sketch's "calm" promise).
                    if (levelAtLeast('medium')) {
                        const popup = document.getElementById('chatbotPopup');
                        const fab = document.getElementById('chatbotFab');
                        if (popup && !popup.classList.contains('open')) {
                            popup.classList.add('open');
                            fab.classList.add('open');
                        }
                    }
                }, 1500);
            }

            // HIGH-only modal swap pop-up (sprint-1 Pro). Fires once per recipe load when
            // there's a high-impact ingredient with a known swap; matches sketch 4's red modal.
            if (isLevel('high') && highImpactIngredients.length > 0) {
                setTimeout(() => maybeShowHighSwapModal(recipe), 2200);
            }
        }
    }

    // ===== HIGH-level modal swap pop-up =====
    // Sprint-1 "Try this swap!" modal - only shown when the user explicitly picked HIGH.
    // Sketch 4 (sprint2-proactiveness-levels.html) marks this as the surface that caused
    // the +275 s time gap and 8/14 distraction complaints, so it must remain opt-in.
    function maybeShowHighSwapModal(recipe) {
        if (!isLevel('high')) return;
        if (!state.currentRecipe || state.currentRecipe !== recipe) return;
        const excluded = getExcludedFoods();
        const candidates = EcoData.findSubstitutableIngredients(recipe.ingredients)
            .map(sub => ({
                ...sub,
                alternatives: sub.alternatives.filter(alt => !excluded.has(alt.replacement.toLowerCase()))
            }))
            .filter(sub => sub.alternatives.length > 0);
        if (candidates.length === 0) return;
        // Pick the swap with the largest savings to feature.
        let best = null;
        candidates.forEach(sub => {
            sub.alternatives.forEach(alt => {
                const s = EcoData.calculateSavings(sub.ingredient, alt.replacement, sub.amount / 1000);
                if (!best || s.savingsKg > best.savingsKg) {
                    best = { original: sub.ingredient, replacement: alt.replacement, amount: sub.amount, savingsKg: s.savingsKg };
                }
            });
        });
        if (!best || best.savingsKg <= 0) return;

        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        if (!overlay || !content) return;
        const equivKm = (best.savingsKg * 4.6).toFixed(0); // ~kg CO2 per km driven
        content.innerHTML = `
            <div class="high-swap-modal">
                <div class="high-swap-modal-header">⚡ Try this swap!</div>
                <div class="high-swap-modal-body">
                    <p><strong>${capitalize(best.replacement)}</strong> for <strong>${capitalize(best.original)}</strong></p>
                    <p class="high-swap-modal-save">save ${best.savingsKg.toFixed(1)} kg CO₂ ≈ ${equivKm} km of driving 🚗</p>
                </div>
                <div class="high-swap-modal-actions">
                    <button class="btn btn-primary" id="highSwapApplyBtn">Apply</button>
                    <button class="btn btn-outline" id="highSwapSkipBtn">Skip</button>
                    <button class="btn btn-outline" id="highSwapLaterBtn">Maybe later</button>
                </div>
            </div>
        `;
        overlay.classList.add('active');
        const close = () => overlay.classList.remove('active');
        document.getElementById('highSwapApplyBtn').onclick = () => {
            close();
            // Find the matching inline-swap button and click it so the swap goes through
            // the normal acceptSuggestion pipeline (impact tracking, toasts, undo state).
            const list = document.getElementById('ingredientList');
            if (list) {
                const target = list.querySelector(`.inline-swap-option[data-replacement="${best.replacement}"][data-ingredient="${best.original}"] .btn-accept`);
                if (target) target.click();
            }
        };
        document.getElementById('highSwapSkipBtn').onclick = close;
        document.getElementById('highSwapLaterBtn').onclick = close;
    }

    function showRecipeNavLink(name) {
        const link = document.getElementById('navRecipeLink');
        const nameSpan = document.getElementById('navRecipeName');
        if (link && nameSpan) {
            // Truncate long names for the nav
            nameSpan.textContent = name.length > 18 ? name.substring(0, 18) + '…' : name;
            link.style.display = '';
            link.title = name;
        }
    }

    function hideRecipeNavLink() {
        const link = document.getElementById('navRecipeLink');
        if (link) link.style.display = 'none';
    }

    function renderDetailView() {
        const recipe = state.currentRecipe;
        const ingredients = state.currentIngredients;

        document.getElementById('detailRecipeName').textContent = recipe.name;
        document.getElementById('detailMeta').innerHTML = `
            <span>🍽️ ${recipe.servings} servings</span>
            <span>⏱️ ${recipe.time}</span>
            <span>🌍 ${recipe.cuisine}</span>
        `;

        // Carbon score
        const totalCO2 = EcoData.calculateRecipeCO2(ingredients);
        const perServing = totalCO2 / recipe.servings;
        const rating = EcoData.getCarbonRating(perServing);

        const gradeEl = document.getElementById('carbonGrade');
        gradeEl.textContent = rating.grade;
        gradeEl.style.background = rating.color;

        const barPercent = Math.min((perServing / 5) * 100, 100);
        const bar = document.getElementById('carbonBar');
        bar.style.width = `${barPercent}%`;
        bar.style.background = rating.color;

        // Apply nudge-mode-aware carbon score display
        const scoreLabel = document.querySelector('.score-label');
        scoreLabel.textContent = 'Carbon Footprint';
        document.getElementById('carbonTotal').textContent = `${totalCO2.toFixed(2)} kg CO₂e total`;
        document.getElementById('carbonPerServing').textContent = `${perServing.toFixed(2)} kg CO₂e/serving`;

        // Proactive: color-coded carbon score card + warning banner for high-impact recipes
        const carbonCard = document.getElementById('carbonScoreCard');
        carbonCard.classList.remove('carbon-warning', 'carbon-caution', 'carbon-good');
        const existingBanner = carbonCard.querySelector('.carbon-warning-banner');
        if (existingBanner) existingBanner.remove();

        if (isProactive()) {
            // All proactive levels get the calm color-coding on the card itself…
            if (perServing >= 3) {
                carbonCard.classList.add('carbon-warning');
            } else if (perServing >= 1.5) {
                carbonCard.classList.add('carbon-caution');
            } else {
                carbonCard.classList.add('carbon-good');
            }
            // …but only MEDIUM+ adds the bright "high-impact" warning banner. Sketch 2 (LOW)
            // shows just a faint side stripe + a corner pill, no banner.
            if (perServing >= 3 && levelAtLeast('medium')) {
                const banner = document.createElement('div');
                banner.className = 'carbon-warning-banner';
                banner.innerHTML = `⚠️ High-impact recipe - ${perServing.toFixed(1)} kg CO₂e/serving is above average. Check the eco-suggestions!`;
                carbonCard.appendChild(banner);
            }
        }

        // Ingredients
        renderIngredientList(ingredients);

        // Suggestions
        renderSuggestions(ingredients);

        // Reset AI suggestions
        document.getElementById('aiSuggestionsContainer').innerHTML = '';
        const aiBtn = document.getElementById('aiSuggestBtn');
        aiBtn.disabled = false;
        aiBtn.innerHTML = '🤖 Ask AI for more swaps';
    }

    function renderIngredientList(ingredients) {
        const list = document.getElementById('ingredientList');
        list.innerHTML = '';

        // Find substitutable ingredients for inline swaps
        const excluded = getExcludedFoods();
        const substitutable = EcoData.findSubstitutableIngredients(ingredients)
            .map(sub => {
                const filtered = sub.alternatives.filter(alt => !excluded.has(alt.replacement.toLowerCase()));
                return { ...sub, alternatives: filtered };
            })
            .filter(sub => sub.alternatives.length > 0);

        const subMap = {};
        substitutable.forEach(sub => {
            subMap[sub.ingredient.toLowerCase()] = sub;
        });

        // LOW only flags the single highest-carbon ingredient (sketch 2 - "1 swap idea").
        // The .ingredient-row impact class is what drives the red/amber side stripe; we
        // suppress it on everything except the top item when the user is on LOW.
        let topImpactIngredientName = null;
        if (isLevel('low')) {
            let maxCO2 = -Infinity;
            ingredients.forEach(ing => {
                const perKg = EcoData.carbonFootprint[ing.name.toLowerCase()] || 1.0;
                if (perKg > maxCO2) { maxCO2 = perKg; topImpactIngredientName = ing.name.toLowerCase(); }
            });
        }

        ingredients.forEach(ing => {
            const co2PerKg = EcoData.carbonFootprint[ing.name.toLowerCase()] || 1.0;
            const co2 = co2PerKg * (ing.amount / 1000);
            let impactClass = 'low-impact';
            if (co2PerKg >= 10) impactClass = 'high-impact';
            else if (co2PerKg >= 4) impactClass = 'medium-impact';

            // LOW: strip the highlight from everything except the one top item.
            if (isLevel('low') && ing.name.toLowerCase() !== topImpactIngredientName) {
                impactClass = 'low-impact';
            }

            const sub = subMap[ing.name.toLowerCase()];

            const row = document.createElement('div');
            row.className = `ingredient-row ${impactClass}`;

            if (sub) {
                const firstAlt = sub.alternatives[0];
                const firstSavings = EcoData.calculateSavings(sub.ingredient, firstAlt.replacement, sub.amount / 1000);

                const altOptionsHTML = sub.alternatives.map((alt, altIdx) => {
                    const savings = EcoData.calculateSavings(sub.ingredient, alt.replacement, sub.amount / 1000);
                    return `
                        <div class="inline-swap-option" data-replacement="${alt.replacement}" data-ingredient="${sub.ingredient}" data-amount="${sub.amount}">
                            <div class="inline-swap-name">${capitalize(alt.replacement)}</div>
                            <div class="inline-swap-saving">🌿 -${savings.savingsKg.toFixed(2)} kg CO₂ (${savings.savingsPercent}%)</div>
                            <button class="btn btn-accept btn-sm" onclick="App.acceptSuggestion(this, '${sub.ingredient.replace(/'/g, "\\'")}', '${alt.replacement.replace(/'/g, "\\'")}', ${sub.amount})">
                                Swap it!
                            </button>
                        </div>`;
                }).join('');

                // Proactive: auto-expand the swap dropdown for high-impact ingredients
                // so the participant sees alternatives immediately. Sketch reserves auto-
                // expand for MEDIUM+ - LOW keeps the row compact (user must seek out info).
                const autoExpand = levelAtLeast('medium') && impactClass === 'high-impact';
                const dropdownClass = autoExpand ? 'inline-swap-dropdown' : 'inline-swap-dropdown collapsed';
                const ariaExpanded = autoExpand ? 'true' : 'false';
                const arrow = autoExpand ? '▴' : '▾';
                row.innerHTML = `
                    <div class="ingredient-item">
                        <span class="ingredient-name">${ing.amount}${ing.unit} ${ing.name}</span>
                        <span class="ingredient-co2">${co2.toFixed(2)} kg CO₂e</span>
                        <button class="btn-swap-toggle" onclick="App.toggleInlineSwap(this)" aria-expanded="${ariaExpanded}" title="View eco swaps">
                            🌿 ${sub.alternatives.length} swap${sub.alternatives.length > 1 ? 's' : ''} ${arrow}
                        </button>
                    </div>
                    <div class="${dropdownClass}" data-ingredient="${sub.ingredient}">
                        ${altOptionsHTML}
                    </div>
                `;
            } else {
                // Check if this ingredient is the result of a swap (show undo)
                const swap = state.appliedSwaps.find(s => s.replacement.toLowerCase() === ing.name.toLowerCase());
                if (swap) {
                    row.innerHTML = `
                        <div class="ingredient-item">
                            <span class="ingredient-name">${ing.amount}${ing.unit} ${ing.name} <span class="swapped-from">(was ${capitalize(swap.original)})</span></span>
                            <span class="ingredient-co2">${co2.toFixed(2)} kg CO₂e</span>
                            <button class="btn btn-undo btn-sm" onclick="App.undoSwap(this, '${swap.original.replace(/'/g, "\\'")}', '${swap.replacement.replace(/'/g, "\\'")}', ${swap.amount})">
                                ↩ Undo
                            </button>
                        </div>
                    `;
                } else {
                    row.innerHTML = `
                        <div class="ingredient-item">
                            <span class="ingredient-name">${ing.amount}${ing.unit} ${ing.name}</span>
                            <span class="ingredient-co2">${co2.toFixed(2)} kg CO₂e</span>
                        </div>
                    `;
                }
            }

            list.appendChild(row);
        });
    }

    function toggleInlineSwap(btn) {
        const row = btn.closest('.ingredient-row');
        const dropdown = row.querySelector('.inline-swap-dropdown');
        const isCollapsed = dropdown.classList.contains('collapsed');
        dropdown.classList.toggle('collapsed');
        btn.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
        btn.innerHTML = isCollapsed
            ? `🌿 ${dropdown.children.length} swap${dropdown.children.length > 1 ? 's' : ''} ▴`
            : `🌿 ${dropdown.children.length} swap${dropdown.children.length > 1 ? 's' : ''} ▾`;
    }

    // ===== Suggestion / Negotiation Engine =====
    function renderSuggestions(ingredients) {
        // Suggestions are now rendered inline within renderIngredientList.
        // This function manages the bulk action buttons.
        const excluded = getExcludedFoods();
        const substitutable = EcoData.findSubstitutableIngredients(ingredients)
            .map(sub => {
                const filtered = sub.alternatives.filter(alt => !excluded.has(alt.replacement.toLowerCase()));
                return { ...sub, alternatives: filtered };
            })
            .filter(sub => sub.alternatives.length > 0);

        if (substitutable.length > 0) {
            document.getElementById('applyAllBtn').style.display = 'flex';
            document.getElementById('dismissAllBtn').style.display = 'flex';
        } else {
            document.getElementById('applyAllBtn').style.display = 'none';
            document.getElementById('dismissAllBtn').style.display = 'none';
        }

        state.suggestionCount += substitutable.length;
    }

    function acceptSuggestion(buttonEl, originalIngredient, replacement, amount) {
        const card = buttonEl.closest('.suggestion-card');
        // For inline swaps, replacement is always provided directly
        if (card) {
            replacement = replacement || card.dataset.replacement;
            card.classList.add('accepted');
            card.querySelector('.suggestion-actions').innerHTML = `
                <span class="text-green font-bold text-sm">✅ ${capitalize(replacement)}</span>
                <button class="btn btn-undo btn-sm" onclick="App.undoSwap(this, '${originalIngredient.replace(/'/g, "\\'")}', '${replacement.replace(/'/g, "\\'")}', ${amount})">
                    ↩ Undo
                </button>
            `;
        }

        // Track the swap for undo
        state.appliedSwaps.push({ original: originalIngredient, replacement, amount });

        // Update ingredients
        state.currentIngredients = state.currentIngredients.map(ing => {
            if (ing.name.toLowerCase() === originalIngredient.toLowerCase()) {
                return { ...ing, name: replacement };
            }
            return ing;
        });

        // Calculate and record savings
        const savings = EcoData.calculateSavings(originalIngredient, replacement, amount / 1000);
        recordSwap(originalIngredient, replacement, savings.savingsKg);

        // Re-render ingredient list and carbon score
        renderIngredientList(state.currentIngredients);
        updateCarbonScore();

        // Reset mood since user is engaging positively
        state.userMood = 'receptive';

        showToast(`Swapped ${originalIngredient} → ${replacement}! Saving ${savings.savingsKg.toFixed(2)} kg CO₂`, 'success');

        // ===== Proactive: celebrate, contextualize, and prompt next action =====
        // LOW gets only the confirmation toast above; the extras below are the MEDIUM+
        // density that the cheatsheet (sketch 6) reserves for users who want more coaching.
        if (levelAtLeast('medium')) {
            const totalSwaps = state.impact.swapsMade || 0;
            const totalSaved = state.impact.totalCO2Saved || 0;

            // Milestone celebrations at 1, 5, 10, 25 swaps.
            if ([1, 5, 10, 25].includes(totalSwaps)) {
                setTimeout(() => {
                    showToast(`🎉 Milestone! ${totalSwaps} eco-swap${totalSwaps === 1 ? '' : 's'} so far - that's ${totalSaved.toFixed(2)} kg CO\u2082e off your footprint.`, 'success');
                }, 1100);
            }

            // CO2 equivalence framing on bigger swaps.
            if (savings.savingsKg >= 1) {
                const equivs = EcoData.getCO2Equivalence(savings.savingsKg);
                if (equivs && equivs.length > 0) {
                    setTimeout(() => {
                        showToast(`🌍 That single swap is ${equivs[0]} - nice one.`, 'info');
                    }, 1800);
                }
            }

            // Follow-up chat nudge once per recipe: encourage stacking more swaps.
            // Counts against the AI-bubble session cap (MEDIUM = 4, HIGH = unlimited).
            const remainingSwaps = document.querySelectorAll('.inline-swap-dropdown .inline-swap-option .btn-accept').length;
            if (remainingSwaps > 0 && state.appliedSwaps.length === 1 && !aiBubbleBudgetExhausted()) {
                setTimeout(() => {
                    _sessionLimits.aiBubbles++;
                    const followUp = `Nice swap! There ${remainingSwaps === 1 ? 'is' : 'are'} still **${remainingSwaps} more eco-swap${remainingSwaps === 1 ? '' : 's'}** available on this recipe. Want me to apply them all in one go?`;
                    appendChatMessage('mainChatMessages', 'assistant', followUp);
                    state.chatHistory.push({ role: 'assistant', content: followUp });
                    const popup = document.getElementById('chatbotPopup');
                    const fab = document.getElementById('chatbotFab');
                    if (popup && !popup.classList.contains('open')) {
                        popup.classList.add('open');
                        if (fab) fab.classList.add('open');
                    }
                }, 2400);
            }
        }
    }

    function undoSwap(buttonEl, originalIngredient, replacement, amount) {
        const card = buttonEl.closest('.suggestion-card');
        if (card) card.classList.remove('accepted');

        // Remove from applied swaps
        const swapIdx = state.appliedSwaps.findIndex(s => s.original === originalIngredient && s.replacement === replacement);
        if (swapIdx !== -1) state.appliedSwaps.splice(swapIdx, 1);

        // Revert the ingredient
        state.currentIngredients = state.currentIngredients.map(ing => {
            if (ing.name.toLowerCase() === replacement.toLowerCase()) {
                return { ...ing, name: originalIngredient };
            }
            return ing;
        });

        // Reverse the impact record
        const savings = EcoData.calculateSavings(originalIngredient, replacement, amount / 1000);
        state.impact.totalCO2Saved -= savings.savingsKg;
        state.impact.swapsMade = Math.max(0, state.impact.swapsMade - 1);
        const dayIndex = new Date().getDay();
        const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;
        state.impact.weeklyData[adjustedIndex] = Math.max(0, state.impact.weeklyData[adjustedIndex] - savings.savingsKg);
        // Remove the most recent matching history entry
        const histIdx = state.impact.history.findIndex(h => h.original === originalIngredient && h.replacement === replacement);
        if (histIdx !== -1) state.impact.history.splice(histIdx, 1);

        renderIngredientList(state.currentIngredients);
        updateCarbonScore();
        updateStreakBadge();
        renderImpactView();
        saveState();

        // Restore the swap/decline buttons (only for suggestion-card based UI)
        if (card) {
            card.querySelector('.suggestion-actions').innerHTML = `
                <button class="btn btn-accept btn-sm" onclick="App.acceptSuggestion(this, '${originalIngredient.replace(/'/g, "\\'")}', null, ${amount})">
                    ✅ Swap it!
                </button>
                <button class="btn btn-decline btn-sm" onclick="App.declineSuggestion(this, '${originalIngredient.replace(/'/g, "\\'")}')">
                    No thanks
                </button>
            `;
            card.dataset.replacement = replacement;
            card.dataset.ingredient = originalIngredient;
        }

        showToast(`Reverted ${replacement} back to ${originalIngredient}`, 'info');
    }

    function declineSuggestion(buttonEl, ingredient) {
        const card = buttonEl.closest('.suggestion-card');
        card.classList.add('declined');
        card.querySelector('.suggestion-actions').innerHTML = '<span class="text-gray text-sm">Keeping original</span>';

        // Track dismissals for this ingredient
        if (!state.dismissedSuggestions[ingredient]) {
            state.dismissedSuggestions[ingredient] = 0;
        }
        state.dismissedSuggestions[ingredient]++;

        // Adjust mood if too many dismissals
        const totalDismissals = Object.values(state.dismissedSuggestions).reduce((a, b) => a + b, 0);
        if (totalDismissals >= 3) {
            state.userMood = 'annoyed';
        }

        // After declining, all alternatives were already visible - no need to suggest another
        saveState();
    }

    function applyAllSuggestions() {
        // Apply first swap option for each ingredient that has inline swaps
        document.querySelectorAll('.inline-swap-dropdown').forEach(dropdown => {
            const firstOption = dropdown.querySelector('.inline-swap-option .btn-accept');
            if (firstOption) firstOption.click();
        });
    }

    function dismissAllSuggestions() {
        // Collapse all inline swap dropdowns
        document.querySelectorAll('.inline-swap-dropdown:not(.collapsed)').forEach(dropdown => {
            dropdown.classList.add('collapsed');
            const row = dropdown.closest('.ingredient-row');
            const toggleBtn = row ? row.querySelector('.btn-swap-toggle') : null;
            if (toggleBtn) {
                toggleBtn.setAttribute('aria-expanded', 'false');
                toggleBtn.innerHTML = `🌿 ${dropdown.children.length} swap${dropdown.children.length > 1 ? 's' : ''} ▾`;
            }
        });
        document.getElementById('applyAllBtn').style.display = 'none';
        document.getElementById('dismissAllBtn').style.display = 'none';
        showToast("No problem! Your recipe stays as is. 🍽️", 'info');
    }

    // ===== AI-Powered Swap Suggestions =====
    async function fetchAISwapSuggestions() {
        if (!state.currentRecipe || !state.currentIngredients) return;

        const btn = document.getElementById('aiSuggestBtn');
        const container = document.getElementById('aiSuggestionsContainer');
        btn.disabled = true;
        btn.innerHTML = '⏳ Thinking...';
        container.innerHTML = '';

        const ingredientsList = state.currentIngredients.map(i => `${i.amount}${i.unit} ${i.name}`).join(', ');
        const totalCO2 = EcoData.calculateRecipeCO2(state.currentIngredients);

        // Figure out which swaps the static engine already suggested so we don't duplicate
        const existingSwaps = [];
        document.querySelectorAll('.suggestion-card').forEach(card => {
            const ing = card.dataset.ingredient;
            if (ing) existingSwaps.push(ing);
        });

        const excluded = getExcludedFoods();
        const excludeNote = excluded.size > 0 ? `\nExcluded foods (allergies/dislikes): ${[...excluded].join(', ')}. Do NOT suggest these.` : '';
        const dietNote = state.dietaryRestrictions.length > 0 ? `\nDietary restrictions: ${state.dietaryRestrictions.join(', ')}.` : '';

        const prompt = `Recipe: ${state.currentRecipe.name}
Ingredients: ${ingredientsList}
Total CO2: ${totalCO2.toFixed(2)} kg CO₂e
Already suggested swaps for: ${existingSwaps.join(', ') || 'none'}${excludeNote}${dietNote}

Suggest 2-3 ADDITIONAL ingredient swaps to lower this recipe's carbon footprint. Focus on swaps NOT already listed above. For each swap, respond in this exact JSON format (no markdown, no extra text):
[{"original":"ingredient name","replacement":"replacement name","savingsEstimate":"X.XX","reason":"one sentence why"}]

Only include swaps where the replacement is a real ingredient that works in this dish. Use kg CO2e for savingsEstimate.`;

        const messages = [
            { role: 'system', content: 'You are Eco-Nudge, a sustainable meal planning assistant. Respond ONLY with valid JSON arrays. No markdown fences, no explanation outside the JSON.' },
            { role: 'user', content: prompt }
        ];

        try {
            const response = await callLLM(messages);
            const cleaned = response.replace(/```json\s*|```\s*/g, '').trim();
            const suggestions = JSON.parse(cleaned);

            if (Array.isArray(suggestions) && suggestions.length > 0) {
                renderAISuggestions(suggestions);
                btn.innerHTML = '🤖 Ask for more swaps';
            } else {
                container.innerHTML = '<p style="text-align:center;color:var(--text-muted);font-size:0.85rem;padding:0.5rem;">No additional swaps found for this recipe.</p>';
                btn.innerHTML = '🤖 Ask AI for more swaps';
            }
        } catch (e) {
            container.innerHTML = '<p style="text-align:center;color:var(--text-muted);font-size:0.85rem;padding:0.5rem;">Couldn\'t get AI suggestions right now. Try the recipe chat below instead.</p>';
            btn.innerHTML = '🤖 Ask AI for more swaps';
        }
        btn.disabled = false;
    }

    function renderAISuggestions(suggestions) {
        const container = document.getElementById('aiSuggestionsContainer');
        container.innerHTML = '';

        suggestions.forEach((sug, idx) => {
            const card = document.createElement('div');
            card.className = 'ai-suggestion-card';
            card.style.animationDelay = `${idx * 0.1}s`;
            card.dataset.original = sug.original;
            card.dataset.replacement = sug.replacement;

            const savingsNum = parseFloat(sug.savingsEstimate) || 0;

            card.innerHTML = `
                <div class="ai-suggestion-swap">
                    ${capitalize(sug.original)} <span class="arrow" style="color:var(--green-600);">→</span> ${capitalize(sug.replacement)}
                </div>
                <div class="ai-suggestion-reason">${sug.reason}</div>
                <div class="ai-suggestion-tags">
                    ${savingsNum > 0 ? `<span class="savings-tag co2">🌿 Save ~${savingsNum.toFixed(2)} kg CO₂</span>` : ''}
                </div>
                <div class="ai-suggestion-actions">
                    <button class="btn btn-accept btn-sm" onclick="App.acceptAISuggestion(this, '${sug.original.replace(/'/g, "\\'")}', '${sug.replacement.replace(/'/g, "\\'")}')">
                        ✅ Swap it
                    </button>
                    <button class="btn btn-decline btn-sm" onclick="App.declineAISuggestion(this)">
                        Skip
                    </button>
                </div>
            `;
            container.appendChild(card);
        });
    }

    function acceptAISuggestion(buttonEl, original, replacement) {
        const card = buttonEl.closest('.ai-suggestion-card');
        card.style.borderColor = 'var(--green-400)';

        // Apply the swap to current ingredients
        const origLower = original.toLowerCase();
        const replLower = replacement.toLowerCase();
        let swappedAmount = 0;
        state.currentIngredients = state.currentIngredients.map(ing => {
            if (ing.name.toLowerCase() === origLower) {
                swappedAmount = ing.amount;
                return { ...ing, name: replLower };
            }
            return ing;
        });

        card.querySelector('.ai-suggestion-actions').innerHTML = `
            <span class="text-green font-bold text-sm">✅ ${capitalize(replacement)}</span>
            <button class="btn btn-undo btn-sm" onclick="App.undoAISwap(this, '${original.replace(/'/g, "\\'")}', '${replacement.replace(/'/g, "\\'")}', ${swappedAmount})">
                ↩ Undo
            </button>
        `;

        if (swappedAmount > 0) {
            const savings = EcoData.calculateSavings(origLower, replLower, swappedAmount / 1000);
            recordSwap(origLower, replLower, savings.savingsKg);
            renderIngredientList(state.currentIngredients);
            updateCarbonScore();
            showToast(`Swapped ${original} → ${replacement}! Saving ${savings.savingsKg.toFixed(2)} kg CO₂`, 'success');
        } else {
            showToast(`Swapped ${original} → ${replacement}!`, 'success');
        }

        state.userMood = 'receptive';
    }

    function undoAISwap(buttonEl, original, replacement, amount) {
        const card = buttonEl.closest('.ai-suggestion-card');
        card.style.borderColor = '';

        // Revert the ingredient
        state.currentIngredients = state.currentIngredients.map(ing => {
            if (ing.name.toLowerCase() === replacement.toLowerCase()) {
                return { ...ing, name: original.toLowerCase() };
            }
            return ing;
        });

        // Reverse the impact record
        if (amount > 0) {
            const savings = EcoData.calculateSavings(original.toLowerCase(), replacement.toLowerCase(), amount / 1000);
            state.impact.totalCO2Saved -= savings.savingsKg;
            state.impact.swapsMade = Math.max(0, state.impact.swapsMade - 1);
            const dayIndex = new Date().getDay();
            const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;
            state.impact.weeklyData[adjustedIndex] = Math.max(0, state.impact.weeklyData[adjustedIndex] - savings.savingsKg);
            const histIdx = state.impact.history.findIndex(h => h.original === original.toLowerCase() && h.replacement === replacement.toLowerCase());
            if (histIdx !== -1) state.impact.history.splice(histIdx, 1);
        }

        renderIngredientList(state.currentIngredients);
        updateCarbonScore();
        updateStreakBadge();
        renderImpactView();
        saveState();

        // Restore swap/skip buttons
        card.querySelector('.ai-suggestion-actions').innerHTML = `
            <button class="btn btn-accept btn-sm" onclick="App.acceptAISuggestion(this, '${original.replace(/'/g, "\\'")}', '${replacement.replace(/'/g, "\\'")}')">
                ✅ Swap it
            </button>
            <button class="btn btn-decline btn-sm" onclick="App.declineAISuggestion(this)">
                Skip
            </button>
        `;

        showToast(`Reverted ${replacement} back to ${original}`, 'info');
    }

    function declineAISuggestion(buttonEl) {
        const card = buttonEl.closest('.ai-suggestion-card');
        card.style.opacity = '0.5';
        card.querySelector('.ai-suggestion-actions').innerHTML = '<span class="text-gray text-sm">Skipped</span>';
    }

    function updateCarbonScore() {
        const totalCO2 = EcoData.calculateRecipeCO2(state.currentIngredients);
        const perServing = totalCO2 / state.currentRecipe.servings;
        const rating = EcoData.getCarbonRating(perServing);

        const gradeEl = document.getElementById('carbonGrade');
        gradeEl.textContent = rating.grade;
        gradeEl.style.background = rating.color;

        const barPercent = Math.min((perServing / 5) * 100, 100);
        document.getElementById('carbonBar').style.width = `${barPercent}%`;
        document.getElementById('carbonBar').style.background = rating.color;

        document.getElementById('carbonTotal').textContent = `${totalCO2.toFixed(2)} kg CO₂e total`;
        document.getElementById('carbonPerServing').textContent = `${perServing.toFixed(2)} kg CO₂e/serving`;

        // Proactive: update color-coding classes
        const carbonCard = document.getElementById('carbonScoreCard');
        carbonCard.classList.remove('carbon-warning', 'carbon-caution', 'carbon-good');
        const existingBanner = carbonCard.querySelector('.carbon-warning-banner');
        if (existingBanner) existingBanner.remove();

        if (isProactive()) {
            if (perServing >= 3) {
                carbonCard.classList.add('carbon-warning');
            } else if (perServing >= 1.5) {
                carbonCard.classList.add('carbon-caution');
            } else {
                carbonCard.classList.add('carbon-good');
            }
            if (perServing >= 3 && levelAtLeast('medium')) {
                const banner = document.createElement('div');
                banner.className = 'carbon-warning-banner';
                banner.innerHTML = `⚠️ High-impact recipe - ${perServing.toFixed(1)} kg CO₂e/serving is above average. Check the eco-suggestions!`;
                carbonCard.appendChild(banner);
            }
        }
    }

    // ===== Impact Tracking =====
    function recordSwap(original, replacement, savingsKg) {
        state.impact.totalCO2Saved += savingsKg;
        state.impact.swapsMade++;

        // Count this meal as optimized on the first swap
        if (!state.currentRecipeOptimized) {
            state.currentRecipeOptimized = true;
            state.impact.mealsOptimized++;
        }

        // Add to history
        state.impact.history.unshift({
            type: 'swap',
            original,
            replacement,
            savings: savingsKg,
            date: new Date().toISOString(),
            recipe: state.currentRecipe?.name || 'Custom Recipe',
        });

        // Update weekly data
        const dayIndex = new Date().getDay();
        const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1; // Mon=0, Sun=6
        state.impact.weeklyData[adjustedIndex] += savingsKg;

        updateStreakBadge();
        renderImpactView();
        saveState();

        // Proactive: prompt user to check impact page after making swaps.
        // MEDIUM+ only - LOW reserves chatter for the batched on-save summary.
        if (levelAtLeast('medium') && state.impact.swapsMade > 0 && state.impact.swapsMade % 3 === 0) {
            setTimeout(() => {
                showToast(`🏆 You've made ${state.impact.swapsMade} swaps! Check your Impact page to see your total savings.`, 'info');
            }, 1500);
        }
    }

    function recordMealOptimized() {
        state.impact.mealsOptimized++;
        checkStreak();
        renderImpactView();
        saveState();
    }

    function checkStreak() {
        const today = new Date().toDateString();
        if (state.impact.lastActiveDate !== today) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            if (state.impact.lastActiveDate === yesterday.toDateString()) {
                state.impact.streak++;
            } else if (state.impact.lastActiveDate !== null) {
                state.impact.streak = 1;
            } else {
                state.impact.streak = 1;
            }
            state.impact.lastActiveDate = today;
            saveState();
        }
    }

    function updateStreakBadge() {
        document.getElementById('streakBadge').textContent = `🔥 ${state.impact.streak}`;
    }

    function renderImpactView() {
        document.getElementById('totalCO2Saved').textContent = state.impact.totalCO2Saved.toFixed(2);
        document.getElementById('mealsOptimized').textContent = state.impact.mealsOptimized;
        document.getElementById('swapsMade').textContent = state.impact.swapsMade;
        document.getElementById('currentStreak').textContent = state.impact.streak;

        // CO2 equivalences
        const equivs = EcoData.getCO2Equivalence(state.impact.totalCO2Saved);
        document.getElementById('co2Equiv').textContent = equivs.length > 0 ? `≈ ${equivs[0]}` : '';

        // History list
        const historyList = document.getElementById('historyList');
        if (state.impact.history.length === 0) {
            historyList.innerHTML = `<div class="history-empty"><p>No eco-choices recorded yet. Start by analyzing a recipe!</p></div>`;
        } else {
            historyList.innerHTML = '';
            state.impact.history.slice(0, 20).forEach(item => {
                const date = new Date(item.date);
                const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const el = document.createElement('div');
                el.className = 'history-item';
                el.innerHTML = `
                    <span class="history-item-icon">🔄</span>
                    <span class="history-item-text">${capitalize(item.original)} → ${capitalize(item.replacement)} in ${item.recipe}</span>
                    <span class="history-item-savings">-${item.savings.toFixed(2)} kg</span>
                    <span class="history-item-date">${dateStr}</span>
                `;
                historyList.appendChild(el);
            });
        }

        // Weekly chart
        const maxVal = Math.max(...state.impact.weeklyData, 0.1);
        document.querySelectorAll('.chart-bar').forEach((bar, index) => {
            const percent = (state.impact.weeklyData[index] / maxVal) * 100;
            bar.style.height = `${Math.max(percent, 2)}%`;
        });
    }

    // ===== Saved Recipes =====
    function saveCurrentRecipe() {
        if (!state.currentRecipe) {
            showToast('No recipe is currently open.', 'warning');
            return;
        }

        const recipe = {
            id: Date.now(),
            name: state.currentRecipe.name,
            ingredients: JSON.parse(JSON.stringify(state.currentIngredients)),
            servings: state.currentRecipe.servings,
            cuisine: state.currentRecipe.cuisine || 'Custom',
            time: state.currentRecipe.time || 'N/A',
            savedAt: new Date().toISOString(),
        };

        state.savedRecipes.push(recipe);
        state.currentRecipeSaved = true;
        saveState();
        renderSavedRecipesView();
        showToast(`"${recipe.name}" saved to My Recipes!`, 'success');
    }

    function renderSavedRecipesView() {
        const grid = document.getElementById('savedRecipesGrid');
        const empty = document.getElementById('savedEmpty');
        if (!grid) return;

        // Clear previous cards (keep the empty placeholder)
        grid.querySelectorAll('.saved-recipe-card').forEach(c => c.remove());

        if (state.savedRecipes.length === 0) {
            if (empty) empty.style.display = '';
            return;
        }
        if (empty) empty.style.display = 'none';

        state.savedRecipes.forEach((recipe, idx) => {
            const totalCO2 = EcoData.calculateRecipeCO2(recipe.ingredients);
            const perServing = totalCO2 / recipe.servings;
            const rating = EcoData.getCarbonRating(perServing);
            const savedDate = new Date(recipe.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

            const card = document.createElement('div');
            card.className = 'saved-recipe-card';
            card.innerHTML = `
                <div class="saved-recipe-header">
                    <h3>${recipe.name}</h3>
                    <span class="carbon-badge" style="background:${rating.color}">${rating.grade}</span>
                </div>
                <div class="saved-recipe-meta">
                    <span>🍽️ ${recipe.servings} servings</span>
                    <span>🌍 ${recipe.cuisine}</span>
                    <span>🌿 ${perServing.toFixed(2)} kg CO₂e/serving</span>
                </div>
                <div class="saved-recipe-ingredients">
                    ${recipe.ingredients.map(i => `${i.amount}${i.unit} ${i.name}`).join(', ')}
                </div>
                <div class="saved-recipe-footer">
                    <span class="saved-recipe-date">Saved ${savedDate}</span>
                    <div class="saved-recipe-actions">
                        <button class="btn btn-sm btn-outline" onclick="App.openSavedRecipe(${idx})">Open</button>
                        <button class="btn btn-sm btn-danger-outline" onclick="App.deleteSavedRecipe(${idx})">🗑️</button>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });
    }

    function openSavedRecipe(index) {
        const recipe = state.savedRecipes[index];
        if (!recipe) return;
        openRecipeDetail({
            id: recipe.id,
            name: recipe.name,
            ingredients: JSON.parse(JSON.stringify(recipe.ingredients)),
            servings: recipe.servings,
            cuisine: recipe.cuisine,
            time: recipe.time,
        });
    }

    function deleteSavedRecipe(index) {
        const recipe = state.savedRecipes[index];
        if (!recipe) return;
        if (confirm(`Delete "${recipe.name}" from your saved recipes?`)) {
            state.savedRecipes.splice(index, 1);
            saveState();
            renderSavedRecipesView();
            showToast('Recipe deleted.', 'info');
        }
    }

    // ===== Custom Recipe Analysis =====
    function openAddRecipeDialog() {
        document.getElementById('addRecipeOverlay').classList.add('active');
    }

    function closeAddRecipeDialog() {
        document.getElementById('addRecipeOverlay').classList.remove('active');
    }

    function analyzeCustomRecipe() {
        const name = document.getElementById('customRecipeName').value.trim();
        const ingredientText = document.getElementById('customIngredients').value.trim();
        const servings = parseInt(document.getElementById('customServings').value) || 4;

        if (!name || !ingredientText) {
            showToast('Please enter a recipe name and ingredients.', 'warning');
            return;
        }

        const ingredients = parseIngredients(ingredientText);
        if (ingredients.length === 0) {
            showToast('Could not parse ingredients. Use format: 500g beef', 'warning');
            return;
        }

        const recipe = {
            id: Date.now(),
            name,
            ingredients,
            servings,
            cuisine: 'Custom',
            time: 'N/A',
        };

        closeAddRecipeDialog();
        // Clear the form
        document.getElementById('customRecipeName').value = '';
        document.getElementById('customIngredients').value = '';
        document.getElementById('customServings').value = '4';

        // Save directly to My Recipes
        recipe.savedAt = new Date().toISOString();
        state.savedRecipes.push(recipe);
        saveState();
        renderSavedRecipesView();
        showToast(`"${recipe.name}" saved to My Recipes!`, 'success');
    }

    async function fetchUnknownIngredientData(unknownIngredients) {
        const names = unknownIngredients.map(i => i.name);
        const prompt = `I need environmental and nutritional data for these food ingredients: ${names.join(', ')}

For EACH ingredient, respond with this exact JSON format (no markdown, no extra text):
[{
  "name": "ingredient name",
  "co2PerKg": 0.0,
  "nutrition": { "calories": 0, "protein": 0, "fiber": 0, "iron": 0, "vitaminC": 0, "category": "protein|grain|vegetable|fruit|dairy|condiment" },
  "healthBenefits": ["benefit1", "benefit2", "benefit3", "benefit4"],
  "substitutions": [
    { "replacement": "lower-carbon alternative", "reason": "One sentence why this is a good eco-friendly swap." }
  ]
}]

Rules:
- co2PerKg should be realistic kg CO2e per kg of the food product based on scientific data.
- Only include substitutions if the ingredient has a co2PerKg above 3.0 (not eco-friendly). For eco-friendly ingredients use an empty array.
- Include 1-3 substitution options if applicable.
- healthBenefits should be short tags like "high fiber", "iron-rich", "vitamin C", etc.
- Use realistic nutritional values per 100g.`;

        const messages = [
            { role: 'system', content: 'You are a food science data assistant. Respond ONLY with valid JSON arrays. No markdown fences, no explanation outside the JSON.' },
            { role: 'user', content: prompt }
        ];

        try {
            const response = await callLLM(messages);
            const cleaned = response.replace(/```json\s*|```\s*/g, '').trim();
            const data = JSON.parse(cleaned);
            if (Array.isArray(data)) {
                data.forEach(item => {
                    if (item.name) {
                        EcoData.addIngredientData(item.name, item);
                    }
                });
                return true;
            }
        } catch (e) {
            console.error('Failed to fetch ingredient data from AI:', e);
        }
        return false;
    }

    function parseIngredients(text) {
        const lines = text.split('\n').filter(l => l.trim());
        return lines.map(line => {
            const match = line.match(/(\d+)\s*(g|gr|grams?|kg|ml|l|oz|cups?|tbsp|tsp)?\s+(.+)/i);
            if (match) {
                let amount = parseInt(match[1]);
                let unit = (match[2] || 'g').toLowerCase();
                const name = match[3].trim().toLowerCase();
                // Normalize units
                if (unit === 'kg') { amount *= 1000; unit = 'g'; }
                if (unit === 'gr' || unit === 'gram' || unit === 'grams') { unit = 'g'; }
                return { name, amount, unit };
            }
            // Fallback: just ingredient name
            return { name: line.trim().toLowerCase(), amount: 100, unit: 'g' };
        });
    }

    // ===== LLM Integration =====
    var SYSTEM_PROMPT = '';

    function buildSystemPrompt() {
        let prompt = `You are Eco-Nudge, a sustainable meal planning assistant. Give direct, data-driven answers. No fluff.

Carbon footprint (kg CO2e/kg): beef 27, lamb 24, chocolate 18.7, coffee 16.5, cheese 13.5, shrimp 11.8, pork 7.6, chicken 6.9, salmon 5.4, eggs 4.8, rice 2.7, tofu 2.0, pasta 1.8, lentils 0.9, chickpeas 0.8, beans 0.7, oats 0.5, potatoes 0.5, vegetables 0.3-1.4.

Rules:
- Lead with the answer, then explain.
- Always include specific CO2 numbers when comparing foods.
- For swaps: state the savings (e.g. "saves 2.1 kg CO2e"), give a 1-sentence reason, and name 2-3 alternatives.
- For recipes: list ingredients with amounts, steps, and total CO2/serving.
- Use bold and bullet points. Keep it under 200 words unless a recipe is requested.
- Respect preferences - suggest, don't push.`;

        // ===== Nudge delivery mode (Research IV) =====
        // Both conditions use the same language. The difference is in WHEN and HOW
        // information is delivered to the user, not what it says.

        // Append focus areas
        const areas = [];
        if (state.focusAreas.carbon) areas.push('carbon footprint reduction');
        if (state.focusAreas.health) areas.push('health improvements');
        if (state.focusAreas.cost) areas.push('cost optimization');
        if (areas.length > 0) {
            prompt += '\n\nThe user wants you to focus on: ' + areas.join(', ') + '. Prioritize suggestions and advice around these areas.';
        }

        // Append dietary preferences
        if (state.dietaryRestrictions.length > 0) {
            prompt += '\n\nThe user has the following dietary preferences/restrictions: ' + state.dietaryRestrictions.join(', ') + '. Always respect these - never suggest ingredients or recipes that violate them.';
        }

        // Append excluded foods (allergies/dislikes)
        if (state.excludedFoods.length > 0) {
            prompt += '\n\nThe user has excluded the following foods (allergies or dislikes): ' + state.excludedFoods.join(', ') + '. NEVER suggest these foods as ingredients or replacements.';
        }

        return prompt;
    }

    function updateSystemPrompt() {
        SYSTEM_PROMPT = buildSystemPrompt();
    }

    async function callLLM(messages) {
        if (!state.aiConnected) await checkAIConnection();
        if (!state.aiConnected) {
            showToast('Not connected to OpenAI. Add your API key in Settings', 'warning');
            return generateFallbackResponse(messages);
        }
        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: openaiHeaders(),
                body: JSON.stringify({
                    model: state.model,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        ...messages.slice(-10),
                    ],
                    temperature: 0.7,
                    max_tokens: 2048,
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error('OpenAI API error:', errText);
                let errMsg = 'OpenAI API error';
                try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch (_) {}
                showToast(errMsg, 'error');
                return generateFallbackResponse(messages);
            }

            const data = await response.json();
            return data.choices?.[0]?.message?.content || generateFallbackResponse(messages);
        } catch (error) {
            console.error('OpenAI call failed:', error);
            showToast('Network error: ' + error.message, 'error');
            state.aiConnected = false;
            return generateFallbackResponse(messages);
        }
    }

    /**
     * Streaming LLM call via OpenAI SSE - yields tokens as they arrive.
     * Falls back to built-in responses when no API key is set.
     */
    async function callLLMStream(messages, onToken) {
        if (!state.aiConnected) await checkAIConnection();
        if (!state.aiConnected) {
            showToast('Not connected to OpenAI. Add your API key in Settings', 'warning');
            const fallback = generateFallbackResponse(messages);
            onToken(fallback, true);
            return fallback;
        }

        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: openaiHeaders(),
                body: JSON.stringify({
                    model: state.model,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        ...messages.slice(-10),
                    ],
                    temperature: 0.7,
                    max_tokens: 2048,
                    stream: true,
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error('OpenAI API error:', errText);
                let errMsg = 'OpenAI API error';
                try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch (_) {}
                showToast(errMsg, 'error');
                const fallback = generateFallbackResponse(messages);
                onToken(fallback, true);
                return fallback;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let full = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                for (const line of chunk.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]') {
                        onToken(full, true);
                        break;
                    }
                    try {
                        const json = JSON.parse(data);
                        const token = json.choices?.[0]?.delta?.content || '';
                        full += token;
                        onToken(full, false);
                    } catch (_) { /* skip malformed */ }
                }
            }
            return full || generateFallbackResponse(messages);
        } catch (error) {
            console.error('OpenAI stream failed:', error);
            showToast('Network error: ' + error.message, 'error');
            state.aiConnected = false;
            const fallback = generateFallbackResponse(messages);
            onToken(fallback, true);
            return fallback;
        }
    }

    // Fallback responses when no API key is set
    function generateFallbackResponse(messages) {
        const lastMsg = messages[messages.length - 1].content.toLowerCase();

        // Recipe-specific context
        if (state.currentRecipe) {
            const substitutable = EcoData.findSubstitutableIngredients(state.currentIngredients);
            if (substitutable.length > 0) {
                const top = substitutable[0];
                const alt = top.alternatives[0];
                const savings = EcoData.calculateSavings(top.ingredient, alt.replacement, top.amount / 1000);
                return `Looking at your ${state.currentRecipe.name}, the biggest opportunity is swapping **${top.ingredient}** (${top.co2PerKg} kg CO₂e/kg) for **${alt.replacement}**.\n\n${alt.reason}\n\nThat swap saves about **${savings.savingsKg.toFixed(2)} kg CO₂**, roughly ${EcoData.getCO2Equivalence(savings.savingsKg)[0] || 'a solid reduction'}.\n\nWant tips on making this work taste-wise?`;
            }
            return `Your ${state.currentRecipe.name} is already pretty green! Total footprint is ${EcoData.calculateRecipeCO2(state.currentIngredients).toFixed(2)} kg CO₂e. Nice pick.`;
        }

        // General conversation responses
        if (lastMsg.includes('beef') || lastMsg.includes('alternative') || lastMsg.includes('substitute')) {
            return `Some solid beef alternatives:\n\n🌱 **Lentils** - 0.9 kg CO₂e/kg (vs 27 for beef). High in protein, iron, fiber.\n🍄 **Mushrooms** - 0.6 kg CO₂e/kg. Good umami, works well in sauces and stews.\n🫘 **Tempeh** - 1.8 kg CO₂e/kg. Fermented soy, ~20g protein per 100g.\n🫛 **Chickpeas** - 0.8 kg CO₂e/kg. Versatile and filling.\n\nDepends on what you're making though. What dish are you going for?`;
        }

        if (lastMsg.includes('carbon') || lastMsg.includes('footprint') || lastMsg.includes('impact')) {
            return `Food carbon footprints vary a lot:\n\n🔴 **High**: Beef (27 kg CO₂e/kg), Lamb (24), Cheese (13.5), Shrimp (11.8)\n🟡 **Medium**: Chicken (6.9), Pork (7.6), Salmon (5.4), Eggs (4.8)\n🟢 **Low**: Lentils (0.9), Beans (0.7), Tofu (2.0), Vegetables (0.3-1.4)\n\nSwapping one beef meal a week for lentils saves ~1,300 kg CO₂/year. That's like driving 6,200 km less.\n\nWant me to check a specific recipe?`;
        }

        if (lastMsg.includes('dinner') || lastMsg.includes('meal') || lastMsg.includes('recipe') || lastMsg.includes('cook')) {
            return `Some low-carbon dinner ideas:\n\n1. 🍲 **Lentil Bolognese** - all the comfort, 90% less carbon than beef\n2. 🥘 **Chickpea Curry** - creamy, filling, cheap\n3. 🍜 **Vegetable Stir-fry with Tofu** - quick and easy to customize\n4. 🥗 **Quinoa Buddha Bowl** - complete protein with roasted veg\n5. 🍝 **Mushroom Pasta** - rich flavor, no meat needed\n\nAll under 1 kg CO₂e per serving. Want a full recipe for any of these?`;
        }

        if (lastMsg.includes('cheese')) {
            return `Cheese has a pretty high footprint: about **13.5 kg CO₂e per kg**. One of the worst dairy products for emissions.\n\nTakes roughly 10 liters of milk to make 1 kg of cheese, so the impact gets concentrated.\n\nSome alternatives:\n🧀 **Nutritional yeast** - cheesy flavor for pasta, popcorn, etc.\n🥜 **Cashew cream** - good for creamy sauces\n\nThat said, a little parmesan goes a long way. You don't have to cut it completely. Want ideas for using less cheese without losing flavor?`;
        }

        if (lastMsg.includes('pasta') || lastMsg.includes('spaghetti')) {
            return `Pasta itself (1.8 kg CO₂e/kg) is pretty moderate. The big differences come from what goes on top:\n\n🔄 **Sauce**: Meat ragù to mushroom/lentil ragù saves ~10 kg CO₂\n🧀 **Cheese**: Use less, or sub nutritional yeast for parmesan flavor\n🫒 **Base**: Olive oil sauces beat cream-based ones\n\nAglio e olio (garlic & olive oil) is one of the lightest pastas you can make, and it's a classic.`;
        }

        return `Here's what I can do:\n\n🥗 **Analyze a recipe** - carbon footprint + greener alternatives\n🔄 **Ingredient swaps** - lower-impact replacements\n📊 **Impact tracking** - see your savings over time\n💡 **Meal planning** - low-carbon meal ideas\n\nTry something like "What's a low-carbon dinner for 4?" or "Help me make my pasta greener".`;
    }

    // ===== Chatbot Popup =====
    function toggleChatbotPopup() {
        const popup = document.getElementById('chatbotPopup');
        const fab = document.getElementById('chatbotFab');
        const isOpen = popup.classList.toggle('open');
        fab.classList.toggle('open', isOpen);
        if (isOpen) {
            const msgs = document.getElementById('mainChatMessages');
            msgs.scrollTop = msgs.scrollHeight;
            document.getElementById('mainChatInput').focus();
        }
    }

    function closeChatbotPopup() {
        document.getElementById('chatbotPopup').classList.remove('open');
        document.getElementById('chatbotFab').classList.remove('open');
    }

    // ===== Chat Functions =====
    async function sendMainChat() {
        const input = document.getElementById('mainChatInput');
        const message = input.value.trim();
        if (!message) return;
        input.value = '';

        // Add user message
        state.chatHistory.push({ role: 'user', content: message });
        appendChatMessage('mainChatMessages', 'user', message);

        // Create a placeholder message for streaming
        const streamEl = appendStreamingMessage('mainChatMessages');

        // Stream LLM response
        const response = await callLLMStream(state.chatHistory, (text, done) => {
            updateStreamingMessage(streamEl, text, done);
        });

        state.chatHistory.push({ role: 'assistant', content: response });
    }

    function appendChatMessage(containerId, role, content) {
        const container = document.getElementById(containerId);
        const msgEl = document.createElement('div');
        msgEl.className = `chat-message ${role}`;
        msgEl.innerHTML = `
            <div class="message-avatar">${role === 'assistant' ? '🌿' : '👤'}</div>
            <div class="message-content">${formatMarkdown(content)}</div>
        `;
        container.appendChild(msgEl);
        container.scrollTop = container.scrollHeight;
    }

    function appendChatLoading(containerId) {
        const container = document.getElementById(containerId);
        const id = 'loading-' + Date.now();
        const el = document.createElement('div');
        el.className = 'chat-message assistant';
        el.id = id;
        el.innerHTML = `
            <div class="message-avatar">🌿</div>
            <div class="message-content">
                <div class="message-loading">
                    <span></span><span></span><span></span>
                </div>
            </div>
        `;
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
        return id;
    }

    function removeChatLoading(id) {
        const el = document.getElementById(id);
        if (el) el.remove();
    }

    /**
     * Append an empty assistant message element for streaming.
     * Returns the DOM element so it can be updated token-by-token.
     */
    function appendStreamingMessage(containerId) {
        const container = document.getElementById(containerId);
        const msgEl = document.createElement('div');
        msgEl.className = 'chat-message assistant';
        msgEl.innerHTML = `
            <div class="message-avatar">🌿</div>
            <div class="message-content streaming-cursor"></div>
        `;
        container.appendChild(msgEl);
        container.scrollTop = container.scrollHeight;
        return msgEl;
    }

    /**
     * Update a streaming message element with the latest accumulated text.
     * Removes the blinking cursor when done.
     */
    function updateStreamingMessage(msgEl, text, done) {
        const contentEl = msgEl.querySelector('.message-content');
        contentEl.innerHTML = formatMarkdown(text);
        if (done) {
            contentEl.classList.remove('streaming-cursor');
        }
        const container = msgEl.parentElement;
        container.scrollTop = container.scrollHeight;
    }

    // ===== Settings =====
    function loadSettingsToForm() {
        document.getElementById('focusCarbon').checked = state.focusAreas.carbon;
        document.getElementById('focusHealth').checked = state.focusAreas.health;
        document.getElementById('focusCost').checked = state.focusAreas.cost;
        // Load dietary checkboxes
        const el = id => document.getElementById(id);
        if (el('dietVegetarian')) el('dietVegetarian').checked = state.dietaryRestrictions.includes('vegetarian');
        if (el('dietVegan')) el('dietVegan').checked = state.dietaryRestrictions.includes('vegan');
        if (el('dietGlutenFree')) el('dietGlutenFree').checked = state.dietaryRestrictions.includes('gluten-free');
        if (el('dietDairyFree')) el('dietDairyFree').checked = state.dietaryRestrictions.includes('dairy-free');
        if (el('dietNutFree')) el('dietNutFree').checked = state.dietaryRestrictions.includes('nut-free');
        renderExcludedFoodTagList();
        // Sync the proactiveness-level dial (shown/hidden by nudge mode).
        updateProactivenessLevelCardVisibility();
    }

    function saveApiKey() {
        const key = document.getElementById('openaiApiKey').value.trim();
        state.openaiApiKey = key;
        state.aiConnected = false;
        saveState();
        checkAIConnection().then(() => {
            if (state.aiConnected) {
                showToast('OpenAI API key saved & verified!', 'success');
            } else if (key) {
                showToast('API key saved but could not connect. Check the key.', 'warning');
            } else {
                showToast('API key cleared.', 'info');
            }
        });
    }

    function saveFocusAreas() {
        state.focusAreas.carbon = document.getElementById('focusCarbon').checked;
        state.focusAreas.health = document.getElementById('focusHealth').checked;
        state.focusAreas.cost = document.getElementById('focusCost').checked;
        updateSystemPrompt();
        saveState();
        showToast('Focus areas saved! AI assistant updated.', 'success');
    }

    function saveDietaryCheckboxes() {
        state.dietaryRestrictions = [];
        if (document.getElementById('dietVegetarian').checked) state.dietaryRestrictions.push('vegetarian');
        if (document.getElementById('dietVegan').checked) state.dietaryRestrictions.push('vegan');
        if (document.getElementById('dietGlutenFree').checked) state.dietaryRestrictions.push('gluten-free');
        if (document.getElementById('dietDairyFree').checked) state.dietaryRestrictions.push('dairy-free');
        if (document.getElementById('dietNutFree').checked) state.dietaryRestrictions.push('nut-free');
        updateSystemPrompt();
        saveState();
        // Re-render suggestion cards and recipe grid to reflect new exclusions
        renderRecipeGrid();
        if (state.currentRecipe) {
            renderSuggestions(state.currentIngredients);
        }
        showToast('Dietary preferences updated! Suggestions refreshed.', 'success');
    }

    function addExcludedFood() {
        const input = document.getElementById('excludeFoodInput');
        const raw = input.value.trim();
        if (!raw) return;

        const items = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
        let added = 0;

        items.forEach(item => {
            const normalized = item.toLowerCase();
            const exists = state.excludedFoods.some(f => f.toLowerCase() === normalized);
            if (!exists) {
                state.excludedFoods.push(normalized);
                added++;
            }
        });

        if (added > 0) {
            updateSystemPrompt();
            saveState();
            renderExcludedFoodTagList();
            renderRecipeGrid();
            if (state.currentRecipe) {
                renderSuggestions(state.currentIngredients);
            }
            showToast(added + ' food' + (added > 1 ? 's' : '') + ' excluded! Suggestions refreshed.', 'success');
        } else {
            showToast('Already in your exclusion list!', 'info');
        }

        input.value = '';
    }

    function removeExcludedFood(index) {
        state.excludedFoods.splice(index, 1);
        updateSystemPrompt();
        saveState();
        renderExcludedFoodTagList();
        renderRecipeGrid();
        if (state.currentRecipe) {
            renderSuggestions(state.currentIngredients);
        }
    }

    function renderExcludedFoodTagList() {
        const container = document.getElementById('excludedFoodTagList');
        if (!container) return;

        if (state.excludedFoods.length === 0) {
            container.innerHTML = '<span style="color:var(--text-secondary);font-style:italic;">No foods excluded yet.</span>';
            return;
        }

        container.innerHTML = '';
        state.excludedFoods.forEach((food, idx) => {
            const tag = document.createElement('span');
            tag.className = 'dietary-tag';
            tag.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;background:var(--card-bg);border:1px solid var(--border);border-radius:20px;font-size:0.9rem;';
            tag.innerHTML = capitalize(food) + ' <button style="background:none;border:none;cursor:pointer;font-size:1.1rem;color:var(--text-secondary);padding:0;line-height:1;" title="Remove">&times;</button>';
            tag.querySelector('button').addEventListener('click', () => removeExcludedFood(idx));
            container.appendChild(tag);
        });
    }

    function clearAllData() {
        if (confirm('This will clear all your saved data, including impact history and preferences. Continue?')) {
            localStorage.removeItem(stateKey());
            location.reload();
        }
    }

    // ===== Utilities =====
    function capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function formatMarkdown(text) {
        // Simple markdown: bold, italic, lists, line breaks
        return text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/^\- (.+)$/gm, '<li>$1</li>')
            .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
            .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>')
            .replace(/^/, '<p>')
            .replace(/$/, '</p>');
    }

    function showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const icons = { success: '✅', info: 'ℹ️', warning: '⚠️', error: '❌' };
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${icons[type]}</span>
            <span class="toast-text">${message}</span>
            <button class="toast-close" onclick="this.parentElement.remove()">×</button>
        `;
        container.appendChild(toast);
        setTimeout(() => {
            if (toast.parentElement) toast.remove();
        }, 5000);
    }

    // ===== Onboarding Wizard =====
    let onboardingStep = 1;
    let onboardingExcludedFoods = [];
    let onboardingUser = null;

    function showOnboarding(user) {
        onboardingUser = user;
        onboardingStep = 1;
        onboardingExcludedFoods = [];
        const overlay = document.getElementById('onboardingOverlay');
        if (overlay) overlay.classList.remove('hidden');
        updateOnboardingUI();
        setupOnboardingListeners();
    }

    function hideOnboarding() {
        const overlay = document.getElementById('onboardingOverlay');
        if (overlay) overlay.classList.add('hidden');
    }

    function setupOnboardingListeners() {
        const nextBtn = document.getElementById('onboardingNext');
        const backBtn = document.getElementById('onboardingBack');
        const addFoodBtn = document.getElementById('obAddExcludeFoodBtn');
        const foodInput = document.getElementById('obExcludeFoodInput');

        // Remove old listeners by cloning
        const newNext = nextBtn.cloneNode(true);
        nextBtn.parentNode.replaceChild(newNext, nextBtn);
        const newBack = backBtn.cloneNode(true);
        backBtn.parentNode.replaceChild(newBack, backBtn);
        const newAddFood = addFoodBtn.cloneNode(true);
        addFoodBtn.parentNode.replaceChild(newAddFood, addFoodBtn);

        newNext.addEventListener('click', onboardingNext);
        newBack.addEventListener('click', onboardingBack);
        newAddFood.addEventListener('click', obAddExcludedFood);
        foodInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') obAddExcludedFood();
        });
    }

    function updateOnboardingUI() {
        // Steps
        for (let i = 1; i <= 3; i++) {
            const stepEl = document.getElementById('onboardingStep' + i);
            if (stepEl) stepEl.classList.toggle('active', i === onboardingStep);
        }
        // Progress bar
        const bar = document.getElementById('onboardingProgressBar');
        if (bar) bar.style.width = ((onboardingStep / 3) * 100) + '%';
        // Step dots
        document.querySelectorAll('.step-dot').forEach(dot => {
            const s = parseInt(dot.dataset.step);
            dot.classList.toggle('active', s === onboardingStep);
            dot.classList.toggle('completed', s < onboardingStep);
        });
        // Back button visibility
        const backBtn = document.getElementById('onboardingBack');
        if (backBtn) backBtn.style.display = onboardingStep === 1 ? 'none' : '';
        // Next button text
        const nextBtn = document.getElementById('onboardingNext');
        if (nextBtn) nextBtn.textContent = onboardingStep === 3 ? "Let's Go!" : 'Next →';
    }

    function onboardingNext() {
        if (onboardingStep < 3) {
            onboardingStep++;
            updateOnboardingUI();
        } else {
            finishOnboarding();
        }
    }

    function onboardingBack() {
        if (onboardingStep > 1) {
            onboardingStep--;
            updateOnboardingUI();
        }
    }

    function obAddExcludedFood() {
        const input = document.getElementById('obExcludeFoodInput');
        const raw = input.value.trim();
        if (!raw) return;
        const items = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
        let added = 0;
        items.forEach(item => {
            const normalized = item.toLowerCase();
            if (!onboardingExcludedFoods.includes(normalized)) {
                onboardingExcludedFoods.push(normalized);
                added++;
            }
        });
        input.value = '';
        if (added > 0) obRenderExcludedTags();
    }

    function obRemoveExcludedFood(idx) {
        onboardingExcludedFoods.splice(idx, 1);
        obRenderExcludedTags();
    }

    function obRenderExcludedTags() {
        const container = document.getElementById('obExcludedFoodTagList');
        if (!container) return;
        if (onboardingExcludedFoods.length === 0) {
            container.innerHTML = '<span style="color:var(--text-secondary);font-style:italic;">No foods excluded yet.</span>';
            return;
        }
        container.innerHTML = '';
        onboardingExcludedFoods.forEach((food, idx) => {
            const tag = document.createElement('span');
            tag.className = 'dietary-tag';
            tag.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;background:var(--card-bg);border:1px solid var(--border);border-radius:20px;font-size:0.9rem;';
            tag.innerHTML = capitalize(food) + ' <button style="background:none;border:none;cursor:pointer;font-size:1.1rem;color:var(--text-secondary);padding:0;line-height:1;" title="Remove">&times;</button>';
            tag.querySelector('button').addEventListener('click', () => obRemoveExcludedFood(idx));
            container.appendChild(tag);
        });
    }

    function finishOnboarding() {
        // Collect preferences from the wizard
        state.focusAreas.carbon = document.getElementById('obFocusCarbon').checked;
        state.focusAreas.health = document.getElementById('obFocusHealth').checked;
        state.focusAreas.cost = document.getElementById('obFocusCost').checked;

        state.dietaryRestrictions = [];
        if (document.getElementById('obDietVegetarian').checked) state.dietaryRestrictions.push('vegetarian');
        if (document.getElementById('obDietVegan').checked) state.dietaryRestrictions.push('vegan');
        if (document.getElementById('obDietGlutenFree').checked) state.dietaryRestrictions.push('gluten-free');
        if (document.getElementById('obDietDairyFree').checked) state.dietaryRestrictions.push('dairy-free');
        if (document.getElementById('obDietNutFree').checked) state.dietaryRestrictions.push('nut-free');

        state.excludedFoods = [...onboardingExcludedFoods];

        hideOnboarding();
        onLoginSuccess(onboardingUser);
        // Persist onboarding preferences immediately so they survive page refresh
        saveState();
        onboardingUser = null;
    }

    // ===== Toggle swap options picker =====
    function toggleSwapOptions(buttonEl) {
        const card = buttonEl.closest('.suggestion-card');
        const picker = card.querySelector('.swap-options-picker');
        const isOpen = !picker.classList.contains('collapsed');
        picker.classList.toggle('collapsed');
        buttonEl.setAttribute('aria-expanded', !isOpen);
        buttonEl.textContent = isOpen
            ? `${card.querySelectorAll('.swap-option').length} options ▾`
            : `${card.querySelectorAll('.swap-option').length} options ▴`;
    }

    // ===== Researcher Condition Indicator =====
    function showResearcherIndicator() {
        const urlParams = new URLSearchParams(window.location.search);
        if (!urlParams.has('condition')) return; // Only show when explicitly set for research

        const existing = document.getElementById('researchConditionBanner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.id = 'researchConditionBanner';
        banner.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
            background: ${isProactive() ? '#2563eb' : '#6b7280'};
            color: white; text-align: center; padding: 4px 12px;
            font-size: 0.75rem; font-weight: 600; letter-spacing: 0.5px;
            font-family: monospace; pointer-events: none; opacity: 0.9;
        `;
        banner.textContent = `RESEARCH MODE - Condition: ${state.nudgeMode.toUpperCase()} - Eco-nudges are ${isProactive() ? 'PUSHED to user (auto-expand, alerts, proactive chat)' : 'PULL-only (collapsed, no alerts, passive chat)'}`;
        document.body.appendChild(banner);

        // Push body content down so banner doesn't overlap nav
        document.body.style.paddingTop = '24px';
    }

    // ===== Set Nudge Mode (called from Eye-Tracking Research panel) =====
    function setNudgeMode(mode) {
        if (mode !== 'proactive' && mode !== 'reactive') return;
        state.nudgeMode = mode;
        console.log('[Research] Nudge mode changed to:', mode);
        saveState();
        showResearcherIndicator();
        updateProactivenessLevelCardVisibility();
        // Re-render views to apply the condition (recipe grid badges/glow,
        // saved-recipes view, and the open detail view if any).
        renderRecipeGrid();
        renderSavedRecipesView();
        if (state.currentRecipe) {
            renderDetailView();
        }
    }

    // ===== Set Proactiveness Level (sprint 2 dial) =====
    function setProactivenessLevel(level) {
        if (!['low', 'medium', 'high'].includes(level)) return;
        state.proactivenessLevel = level;
        console.log('[Research] Proactiveness level changed to:', level);
        saveState();
        // Reset per-session caps so the new level can fire its appropriate cadence
        // immediately on the next interaction.
        _sessionLimits.aiBubbles = 0;
        _sessionLimits.tipToasts = 0;
        _sessionLimits.milestonesShown = 0;
        renderProactivenessLevelCard();
        renderRecipeGrid();
        renderSavedRecipesView();
        if (state.currentRecipe) {
            renderDetailView();
        }
        showToast(`Eco-coaching level set to ${level.toUpperCase()}.`, 'info');
    }

    // Show the dial only when the user is in proactive mode (the dial controls
    // *how much* proactive help to push; reactive mode means none of it fires).
    function updateProactivenessLevelCardVisibility() {
        const card = document.getElementById('proactivenessLevelCard');
        if (!card) return;
        card.style.display = isProactive() ? '' : 'none';
        if (isProactive()) renderProactivenessLevelCard();
    }

    // Reflect the current level on the dial UI (active pill + description).
    function renderProactivenessLevelCard() {
        const level = getProactivenessLevel();
        document.querySelectorAll('#proactivenessLevelCard .level-option').forEach(el => {
            el.classList.toggle('active', el.dataset.level === level);
        });
        const desc = document.getElementById('proactivenessLevelDesc');
        if (desc) {
            const copy = {
                low:    '🌱 LOW - 1 inline cue, 1-2 toasts, 1-2 AI bubbles, batched summary on save.',
                medium: '🌿 MEDIUM - all med/high cues, pinned panel, 3-4 toasts, 3-4 AI bubbles, no modal.',
                high:   '🔥 HIGH - full coaching: modal swap pop-ups, per-swap toasts, impact strip, animated streak.'
            };
            desc.textContent = copy[level] || '';
        }
    }

    // ===== Public API =====
    return {
        init,
        acceptSuggestion,
        declineSuggestion,
        acceptAISuggestion,
        declineAISuggestion,
        undoSwap,
        undoAISwap,
        toggleSwapOptions,
        toggleInlineSwap,
        openSavedRecipe,
        deleteSavedRecipe,
        getState: () => state,
        setNudgeMode,
        setProactivenessLevel,
        getProactivenessLevel,
    };
})();

// Initialize on load
document.addEventListener('DOMContentLoaded', App.init);
