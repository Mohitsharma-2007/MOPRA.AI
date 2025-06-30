from quart import Quart, request, jsonify, render_template
import subprocess
import os
import time
from datetime import datetime
import platform
import threading
import psutil
import signal
import requests
import google.generativeai as genai
from anthropic import Anthropic
from openai import OpenAI
from dotenv import load_dotenv
import httpx
import asyncio

# Load environment variables from .env file
load_dotenv(dotenv_path='../.env')

app = Quart(__name__,
            template_folder='../Frontend/templates',
            static_folder='../Frontend/static')

# Global process management
active_processes = {}  # Changed to dict to store model info
model_lock = threading.Lock()
current_model = "phi3"  # Default model

# Memory management
memory = []
memory_lock = threading.Lock()

# Load environment variables for API keys
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
ANTHROPIC_API_KEY = os.getenv('ANTHROPIC_API_KEY')
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
DEEPSEEK_API_KEY = os.getenv('DEEPSEEK_API_KEY')
GITHUB_API_KEY = os.getenv('GITHUB_COPILOT_API_KEY')

# Initialize AI clients only if API keys are available
openai_client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None
if GOOGLE_API_KEY:
    genai.configure(api_key=GOOGLE_API_KEY)

# Initialize HTTP client for async requests
http_client = httpx.AsyncClient()

def terminate_model_processes(except_model=None):
    """Stop all running Ollama processes except the specified model"""
    terminated_count = 0
    
    def kill_process(proc):
        try:
            if platform.system() == "Windows":
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except psutil.TimeoutExpired:
                    proc.kill()
            else:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, signal.SIGTERM)
                try:
                    proc.wait(timeout=3)
                except psutil.TimeoutExpired:
                    os.killpg(pgid, signal.SIGKILL)
            return True
        except (ProcessLookupError, psutil.NoSuchProcess):
            return False
        except Exception as e:
            print(f"Error terminating process {proc.pid}: {str(e)}")
            return False

    # First, handle tracked processes
    with model_lock:
        for pid in list(active_processes.keys()):
            try:
                if except_model and active_processes[pid] == except_model:
                    continue
                
                process = psutil.Process(pid)
                if kill_process(process):
                    terminated_count += 1
                del active_processes[pid]
                
            except (ProcessLookupError, psutil.NoSuchProcess):
                del active_processes[pid]
            except Exception as e:
                print(f"Error terminating process {pid}: {str(e)}")

    # Then find and kill any other Ollama processes
    try:
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            try:
                if proc.pid in active_processes:
                    continue
                
                # Check if it's an Ollama process
                if proc.info['name'] and 'ollama' in proc.info['name'].lower():
                    if kill_process(proc):
                        terminated_count += 1
                elif proc.info['cmdline']:
                    cmdline = ' '.join(proc.info['cmdline']).lower()
                    if 'ollama' in cmdline:
                        if kill_process(proc):
                            terminated_count += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception as e:
        print(f"Error scanning for Ollama processes: {str(e)}")
    
    return terminated_count

def ensure_model_loaded(model):
    """Pull and set only the requested model"""
    global current_model
    
    if model == current_model:
        return True
        
    try:
        # Stop other models first
        terminate_model_processes(except_model=model)
        
        # Pull new model
        print(f"⏳ Loading model: {model}")
        result = subprocess.run(
            f"ollama pull {model}",
            shell=True,
            capture_output=True,
            text=True,
            timeout=300  # 5 minute timeout
        )
        
        if result.returncode == 0:
            current_model = model
            print(f"✅ Model loaded: {model}")
            return True
        print(f"❌ Failed to load {model}: {result.stderr}")
        return False
            
    except subprocess.TimeoutExpired:
        print(f"🔥 Model pull timed out: {model}")
        return False
    except Exception as e:
        print(f"🔥 Model load error: {str(e)}")
        return False

def run_model(prompt, model, timeout=120):
    """Run model with exclusive loading"""
    if not ensure_model_loaded(model):
        return {"error": f"Failed to load model: {model}"}
    
    process = None
    try:
        creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP if platform.system() == "Windows" else 0
        cmd = f'ollama run {model} "{prompt}"'
        process = subprocess.Popen(
            cmd,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=creation_flags,
            bufsize=1,
            universal_newlines=True
        )
        
        with model_lock:
            active_processes[process.pid] = model
        
        output = []
        start_time = time.time()
        last_output_time = start_time
        
        while True:
            if time.time() - start_time > timeout:
                raise TimeoutError("Response timed out")
                
            line = process.stdout.readline()
            if not line:
                if process.poll() is not None:
                    break
                if time.time() - last_output_time > 30:
                    raise TimeoutError("No output received for 30 seconds")
                time.sleep(0.1)
                continue
                
            last_output_time = time.time()
            output.append(line.strip())
            
        return {
            "content": "\n".join(output),
            "model": model.split(':')[0],
            "status": "success"
        }
        
    except TimeoutError as e:
        if process and process.pid in active_processes:
            del active_processes[process.pid]
            process.terminate()
        return {"error": str(e), "status": "timeout"}
    except Exception as e:
        return {"error": str(e), "status": "error"}
    finally:
        if process and process.poll() is None:
            process.terminate()
            if process.pid in active_processes:
                del active_processes[process.pid]

async def query_chatgpt(query):
    """Query ChatGPT API"""
    if not openai_client:
        return "ChatGPT Error: API key not configured"
    try:
        response = await openai_client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": query}]
        )
        return response.choices[0].message.content
    except Exception as e:
        return f"ChatGPT Error: {str(e)}"

async def query_claude(query):
    """Query Claude API"""
    if not anthropic_client:
        return "Claude Error: API key not configured"
    try:
        response = await anthropic_client.messages.create(
            model="claude-3-sonnet-20240229",
            max_tokens=1024,
            messages=[{"role": "user", "content": query}]
        )
        return response.content[0].text
    except Exception as e:
        return f"Claude Error: {str(e)}"

async def query_gemini(query):
    """Query Gemini API"""
    if not GOOGLE_API_KEY:
        return "Gemini Error: API key not configured"
    try:
        model = genai.GenerativeModel('gemini-pro')
        response = await model.generate_content(query)
        return response.text
    except Exception as e:
        return f"Gemini Error: {str(e)}"

async def query_copilot(query):
    """Query GitHub Copilot API"""
    if not GITHUB_API_KEY:
        return "Copilot Error: API key not configured"
    try:
        headers = {
            "Authorization": f"Bearer {GITHUB_API_KEY}",
            "Content-Type": "application/json",
        }
        async with http_client.post(
            "https://api.github.com/copilot/v1/chat/completions",
            headers=headers,
            json={"messages": [{"role": "user", "content": query}]}
        ) as response:
            result = await response.json()
            return result.get("choices", [{}])[0].get("message", {}).get("content", "No response")
    except Exception as e:
        return f"Copilot Error: {str(e)}"

async def query_deepseek(query):
    """Query DeepSeek API"""
    if not DEEPSEEK_API_KEY:
        return "DeepSeek Error: API key not configured"
    try:
        headers = {
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
        }
        async with http_client.post(
            "https://api.deepseek.com/v1/chat/completions",
            headers=headers,
            json={
                "model": "deepseek-chat",
                "messages": [{"role": "user", "content": query}]
            }
        ) as response:
            result = await response.json()
            return result.get("choices", [{}])[0].get("message", {}).get("content", "No response")
    except Exception as e:
        return f"DeepSeek Error: {str(e)}"

def update_memory(prompt, response):
    """Update the memory with a new conversation"""
    with memory_lock:
        memory.append({
            "prompt": prompt,
            "response": response,
            "timestamp": datetime.now().isoformat()
        })
        # Keep only the last 50 conversations to prevent memory from growing too large
        if len(memory) > 50:
            memory.pop(0)
    return True

def get_memory():
    """Get the current memory"""
    with memory_lock:
        return memory.copy()

def clear_memory():
    """Clear the memory"""
    with memory_lock:
        memory.clear()
    return True

@app.route('/')
async def home():
    return await render_template('index.html')

@app.route('/api/query', methods=['POST'])
async def api_query():
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400
        
    data = await request.get_json()
    model = "phi3"  # Force using Phi-3
    prompt = data.get('prompt', '').strip()
    
    if not prompt:
        return jsonify({"error": "No prompt provided"}), 400
    
    try:
        # Ensure model is loaded
        if not ensure_model_loaded(model):
            return jsonify({"error": f"Failed to load model: {model}"}), 500
        
        # Run the model
        response = run_model(prompt, model)
        response["timestamp"] = datetime.now().isoformat()
        
        if "error" in response:
            return jsonify(response), 500
            
        # Update memory with the conversation
        update_memory(prompt, response.get("content", ""))
        
        return jsonify(response)
        
    except Exception as e:
        return jsonify({
            "error": str(e),
            "status": "error",
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/optimize-ram', methods=['POST'])
async def optimize_ram():
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400
        
    data = await request.get_json()
    current_model = data.get('current_model')
    
    if not current_model:
        return jsonify({"error": "No model specified"}), 400
    
    try:
        terminated = terminate_model_processes(except_model=current_model)
        
        # Force garbage collection
        import gc
        gc.collect()
        
        return jsonify({
            "status": "success",
            "terminated": terminated,
            "current_model": current_model,
            "timestamp": datetime.now().isoformat()
        })
        
    except Exception as e:
        return jsonify({
            "status": "error",
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/stop-all', methods=['POST'])
async def stop_all():
    terminated = terminate_model_processes()
    
    # Additional cleanup
    try:
        # Force garbage collection
        import gc
        gc.collect()
        
        global current_model
        current_model = None
        
    except Exception as e:
        print(f"Error during cleanup: {str(e)}")
    
    return jsonify({
        "status": "success",
        "terminated": terminated,
        "current_model": None,
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/online-search', methods=['POST'])
async def online_search():
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400
        
    data = await request.get_json()
    query = data.get('query', '').strip()
    ai_platform = data.get('ai_platform', '').lower()
    
    if not query:
        return jsonify({"error": "No query provided"}), 400

    try:
        # Route to appropriate AI platform
        response_content = None
        if ai_platform == 'chatgpt':
            if not OPENAI_API_KEY:
                return jsonify({"error": "OpenAI API key not configured"}), 500
            response_content = await query_chatgpt(query)
        elif ai_platform == 'claude':
            if not ANTHROPIC_API_KEY:
                return jsonify({"error": "Anthropic API key not configured"}), 500
            response_content = await query_claude(query)
        elif ai_platform == 'gemini':
            if not GOOGLE_API_KEY:
                return jsonify({"error": "Google API key not configured"}), 500
            response_content = await query_gemini(query)
        elif ai_platform == 'copilot':
            if not GITHUB_API_KEY:
                return jsonify({"error": "GitHub Copilot API key not configured"}), 500
            response_content = await query_copilot(query)
        elif ai_platform == 'deepseek':
            if not DEEPSEEK_API_KEY:
                return jsonify({"error": "DeepSeek API key not configured"}), 500
            response_content = await query_deepseek(query)
        else:
            return jsonify({"error": f"Unsupported AI platform: {ai_platform}"}), 400

        return jsonify({
            "status": "success",
            "content": response_content,
            "ai_platform": ai_platform,
            "timestamp": datetime.now().isoformat()
        })
        
    except Exception as e:
        return jsonify({
            "status": "error",
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/memory', methods=['GET'])
async def get_conversation_memory():
    """Get the conversation memory"""
    try:
        return jsonify({
            "status": "success",
            "memory": get_memory(),
            "timestamp": datetime.now().isoformat()
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

@app.route('/api/memory/clear', methods=['POST'])
async def clear_conversation_memory():
    """Clear the conversation memory"""
    try:
        clear_memory()
        return jsonify({
            "status": "success",
            "message": "Memory cleared successfully",
            "timestamp": datetime.now().isoformat()
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000, host='127.0.0.1', use_reloader=False)