let abortController = null;
const stopButton = document.getElementById('stopButton');
const stopAllButton = document.getElementById('stopAllButton');
let chatHistory = [];

// DOM Elements
const chatWindow = document.getElementById('chatWindow');
const userInput = document.getElementById('userInput');
const sendButton = document.getElementById('sendButton');
const clearHistoryBtn = document.getElementById('clearHistory');
const currentModel = document.getElementById('currentModel');
const modelSelector = document.getElementById('modelSelector');
const modelStatus = document.getElementById('modelStatus');
const ramOptimizeButton = document.getElementById('ramOptimizeButton');

// Online Search Elements
const onlineSearchButton = document.getElementById('onlineSearchButton');
const onlineSearchModal = document.getElementById('onlineSearchModal');
const closeModal = document.querySelector('.close-modal');
const onlineSearchInput = document.getElementById('onlineSearchInput');
const onlineSearchSubmit = document.getElementById('onlineSearchSubmit');
const searchResult = document.getElementById('searchResult');
const aiOptions = document.querySelectorAll('.ai-option');

// Memory Elements
const memoryUpdateButton = document.getElementById('memoryUpdateButton');
const memoryModal = document.getElementById('memoryModal');
const memoryContainer = document.getElementById('memoryContainer');
const clearMemoryButton = document.getElementById('clearMemoryButton');
const refreshMemoryButton = document.getElementById('refreshMemoryButton');

// Available models
const availableModels = {
    'phi3': 'Phi-3'
};

// Initialize
function init() {
    loadHistory();
    loadModelSelection();
    setupEventListeners();
}

// Load saved history
function loadHistory() {
    const saved = localStorage.getItem('mopraChatHistory');
    if (saved) {
        chatHistory = JSON.parse(saved);
        renderHistory();
    }
}

// Load model selection
function loadModelSelection() {
    modelSelector.value = 'phi3';
    updateModelDisplay('phi3');
}

// Update model display with status
function updateModelDisplay(model) {
    currentModel.textContent = 'Phi-3';
    document.getElementById('currentModelDisplay').textContent = model;
    modelStatus.className = 'badge bg-success';
    modelStatus.textContent = 'Ready';
}

// Save to localStorage
function saveHistory() {
    localStorage.setItem('mopraChatHistory', JSON.stringify(chatHistory));
}

// Add message to chat
function addMessage(role, content, model) {
    const message = {
        role,
        content,
        model: model || modelSelector.value.split(':')[0],
        timestamp: new Date().toISOString()
    };
    chatHistory.push(message);
    renderHistory();
    saveHistory();
}

// Render all messages
function renderHistory() {
    chatWindow.innerHTML = '';
    
    if (chatHistory.length === 0) {
        chatWindow.innerHTML = `
            <div class="text-center text-muted mt-5">
                Start chatting with your local AI...
            </div>
        `;
        return;
    }

    chatHistory.forEach(msg => {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${msg.role === 'user' ? 'user-message' : 'ai-message'}`;
        
        if (msg.role === 'ai') {
            messageDiv.innerHTML = `
                <div class="d-flex align-items-start">
                    <div class="flex-grow-1">
                        ${msg.content.replace(/\n/g, '<br>')}
                    </div>
                    <span class="model-badge badge ms-2">${msg.model}</span>
                </div>
                <small class="text-muted d-block mt-1">${new Date(msg.timestamp).toLocaleTimeString()}</small>
            `;
        } else {
            messageDiv.innerHTML = msg.content.replace(/\n/g, '<br>');
        }
        
        chatWindow.appendChild(messageDiv);
    });
    
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

// Send message to backend
async function sendMessage() {
    const prompt = userInput.value.trim();
    if (!prompt) return;

    // Cancel any previous request
    if (abortController) {
        abortController.abort();
    }
    
    abortController = new AbortController();
    stopButton.disabled = false;
    
    // Add user message
    addMessage('user', prompt);
    userInput.value = '';
    
    // Show loading indicator
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message ai-message text-center';
    loadingDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Thinking...';
    chatWindow.appendChild(loadingDiv);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    // Update model status
    modelStatus.className = 'badge bg-warning';
    modelStatus.textContent = 'Processing';

    try {
        const response = await fetch('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                prompt: prompt,
                model: modelSelector.value
            }),
            signal: abortController.signal
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        chatWindow.removeChild(loadingDiv);
        
        if (data.error) {
            modelStatus.className = 'badge bg-danger';
            modelStatus.textContent = 'Error';
            addMessage('ai', `Error: ${data.error}`, 'system');
        } else {
            modelStatus.className = 'badge bg-success';
            modelStatus.textContent = 'Ready';
            addMessage('ai', data.content, data.model);
        }
        
    } catch (error) {
        chatWindow.removeChild(loadingDiv);
        
        if (error.name === 'AbortError') {
            modelStatus.className = 'badge bg-secondary';
            modelStatus.textContent = 'Stopped';
            addMessage('ai', 'Response stopped by user', 'system');
        } else {
            modelStatus.className = 'badge bg-danger';
            modelStatus.textContent = 'Error';
            addMessage('ai', `Error: ${error.message}`, 'system');
        }
    } finally {
        abortController = null;
        stopButton.disabled = true;
    }
}

// Stop all models function
async function stopAllModels() {
    modelStatus.className = 'badge bg-warning';
    modelStatus.textContent = 'Stopping...';
    
    try {
        const response = await fetch('/api/stop-all', {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
            modelStatus.className = 'badge bg-success';
            modelStatus.textContent = 'Stopped';
            
            // Reset any ongoing request
            if (abortController) {
                abortController.abort();
                abortController = null;
            }
            
            // Update UI
            stopButton.disabled = true;
            
            setTimeout(() => {
                modelStatus.textContent = 'Ready';
            }, 2000);
        } else {
            throw new Error(result.error || 'Failed to stop models');
        }
        
    } catch (error) {
        modelStatus.className = 'badge bg-danger';
        modelStatus.textContent = 'Stop Failed';
        console.error("Failed to stop models:", error);
    }
}

// RAM Optimize function
async function optimizeRam() {
    const currentModelValue = modelSelector.value;
    modelStatus.className = 'badge bg-warning';
    modelStatus.textContent = 'Optimizing RAM...';
    
    try {
        const response = await fetch('/api/optimize-ram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                current_model: currentModelValue
            })
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
            modelStatus.className = 'badge bg-success';
            modelStatus.textContent = 'RAM Optimized';
            setTimeout(() => {
                modelStatus.textContent = 'Ready';
            }, 2000);
        } else {
            throw new Error(result.error || 'Optimization failed');
        }
        
    } catch (error) {
        modelStatus.className = 'badge bg-danger';
        modelStatus.textContent = 'Optimization Failed';
        console.error("RAM optimization failed:", error);
    }
}

// Online Search Functions
function showModal() {
    console.log('Opening modal...');
    if (onlineSearchModal) {
        onlineSearchModal.style.display = 'block';
        document.body.style.overflow = 'hidden';
        onlineSearchInput.value = '';
        onlineSearchInput.focus();
    } else {
        console.error('Modal element not found');
    }
}

function hideModal() {
    console.log('Closing modal...');
    if (onlineSearchModal) {
        onlineSearchModal.style.display = 'none';
        document.body.style.overflow = 'auto';
        onlineSearchInput.value = '';
        searchResult.innerHTML = '<div class="text-center text-muted">Search results will appear here...</div>';
    }
}

async function performOnlineSearch() {
    const query = onlineSearchInput.value.trim();
    if (!query) return;

    const selectedAI = document.querySelector('.ai-option.active').dataset.ai;
    searchResult.innerHTML = '<div class="text-center"><i class="fas fa-spinner fa-spin"></i> Searching...</div>';

    try {
        const response = await fetch('/api/online-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                query: query,
                ai_platform: selectedAI
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            searchResult.innerHTML = `<div class="text-danger">Error: ${data.error}</div>`;
        } else {
            searchResult.innerHTML = `
                <div class="mb-2">
                    <small class="text-muted">Results from ${selectedAI.toUpperCase()}:</small>
                </div>
                <div>${data.content.replace(/\n/g, '<br>')}</div>
            `;
        }
        
    } catch (error) {
        searchResult.innerHTML = `<div class="text-danger">Error: ${error.message}</div>`;
    }
}

// Memory Functions
function showMemoryModal() {
    console.log('Opening memory modal...');
    if (memoryModal) {
        memoryModal.style.display = 'block';
        document.body.style.overflow = 'hidden';
        loadMemory();
    } else {
        console.error('Memory modal element not found');
    }
}

function hideMemoryModal() {
    console.log('Closing memory modal...');
    if (memoryModal) {
        memoryModal.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
}

async function loadMemory() {
    if (!memoryContainer) return;
    
    memoryContainer.innerHTML = '<div class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading memory...</div>';
    
    try {
        const response = await fetch('/api/memory');
        const data = await response.json();
        
        if (data.error) {
            memoryContainer.innerHTML = `<div class="text-danger">Error: ${data.error}</div>`;
            return;
        }
        
        if (!data.memory || data.memory.length === 0) {
            memoryContainer.innerHTML = '<div class="text-center text-muted">No memory entries yet.</div>';
            return;
        }
        
        // Display memory in reverse order (newest first)
        const memoryHTML = data.memory.slice().reverse().map(item => `
            <div class="memory-item">
                <div class="memory-prompt">${item.prompt}</div>
                <div class="memory-response">${item.response.replace(/\n/g, '<br>')}</div>
                <div class="memory-timestamp">${new Date(item.timestamp).toLocaleString()}</div>
            </div>
        `).join('');
        
        memoryContainer.innerHTML = memoryHTML;
        
    } catch (error) {
        memoryContainer.innerHTML = `<div class="text-danger">Error: ${error.message}</div>`;
    }
}

async function clearMemory() {
    if (!confirm('Are you sure you want to clear all memory?')) {
        return;
    }
    
    try {
        const response = await fetch('/api/memory/clear', {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.error) {
            alert(`Error: ${data.error}`);
            return;
        }
        
        // Reload memory
        loadMemory();
        
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

// Setup all event listeners
function setupEventListeners() {
    // Chat event listeners
    sendButton.addEventListener('click', sendMessage);
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    clearHistoryBtn.addEventListener('click', () => {
        if (confirm('Clear all chat history?')) {
            chatHistory = [];
            saveHistory();
            renderHistory();
        }
    });

    stopButton.addEventListener('click', async () => {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
        await stopAllModels();
    });

    ramOptimizeButton.addEventListener('click', optimizeRam);

    modelSelector.addEventListener('change', () => {
        const model = modelSelector.value;
        localStorage.setItem('selectedModel', model);
        updateModelDisplay(model);
        modelStatus.className = 'badge bg-warning';
        modelStatus.textContent = 'Loading Model...';
    });

    // Online Search event listeners
    if (onlineSearchButton) {
        onlineSearchButton.onclick = showModal;
    }

    if (closeModal) {
        closeModal.onclick = hideModal;
    }

    if (onlineSearchModal) {
        onlineSearchModal.onclick = function(e) {
            if (e.target === onlineSearchModal) {
                hideModal();
            }
        };
    }

    if (onlineSearchInput) {
        onlineSearchInput.onkeypress = function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                performOnlineSearch();
            }
        };
    }

    if (onlineSearchSubmit) {
        onlineSearchSubmit.onclick = performOnlineSearch;
    }

    if (aiOptions) {
        aiOptions.forEach(option => {
            option.onclick = function() {
                aiOptions.forEach(opt => opt.classList.remove('active'));
                this.classList.add('active');
            };
        });
    }

    // Memory event listeners
    if (memoryUpdateButton) {
        memoryUpdateButton.onclick = showMemoryModal;
    }

    if (memoryModal) {
        memoryModal.onclick = function(e) {
            if (e.target === memoryModal) {
                hideMemoryModal();
            }
        };
    }

    if (clearMemoryButton) {
        clearMemoryButton.onclick = clearMemory;
    }

    if (refreshMemoryButton) {
        refreshMemoryButton.onclick = loadMemory;
    }
}

// Initialize the app
document.addEventListener('DOMContentLoaded', function() {
    console.log('Initializing app...');
    init();
});