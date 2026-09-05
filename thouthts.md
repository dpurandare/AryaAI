I want to create a portable desktop application and the main points are as follows:

1. The application will run on Linux, Mac and Windows. We may consider using the Electron application development framework. We will use JavaScript/TypeScript as our preference for the development language. The application used the Agentic AI. We should not use any third party Agentic AI Framework (such as LangChain) and develop our own Agentic AI layer (similar to what Anthropic developed and available as https://www.npmjs.com/package/@anthropic-ai/sdk)

2. The application will have installers for individual OS. Necessary CI/CD and Auto Updation should be taken care of. 

3. The application will maintain the version numbers. The version number policy would be major, minor, point release type that is followed in the industry. 

4. The application will not have any backend server needs and should run independently.

5. The application should facilitate the access to the public as well as local LLMs. We should support OpenAI, Anthropic, Google, Ollama in the beginning. It should be possible to add the support for any new model provider easily.

6. User should be given facility to choose the LLM model during runtime. 
Unified Provider Adapter Layer: Define a standardized internal schema for tool definitions and streaming events, with thin adapters converting to/from Anthropic Tool Use, OpenAI Function Calling, Gemini Tools, and Ollama tool formats.

7. There should be facility to register the subscriptions to the LLM providers through their API/Keys, etc. 

8. The application have Multi-Agent AI system with following main aspects:
- Provide the chat session to the user.
- Every chat session will be preserved in persistent memory and user may explicitly export the session information and/or delete the session. User cannot delete the current session :) .
- User should be able to create a new session, in that case the current session is preserved and a new one is started. 
- The user interface should show the list of previous sessions in a scrollable, resizable panel on left side of main window.
- The application keeps track of the the context size of the current model, currently used context and warn when it reaches a low level. Also, the agentic AI can decide what is relevant in the context to be sent to LLM and not put everything in the conversation thread in the context. 
- The Agentic AI and the agents will have necessary tools to handle the tasks. Some of the tools the agents will have are: 
	-- Web search
	-- Shell execution
    -- Database access
    -- File Operations
    -- AWS Operations : Using configured AWS CLI
    -- Azure Operations : Using Configured Azure CLI
    -- GCP Operations : Using GCloud
- There should be Human-in-loop confirmations on every tool call that is going to make any change of state. There should be facility to configure the auto-approve.
- There should be facility to specify workspace boundaries so that the Agents operate within those constraints. 
- The Agents should be able to create and enhance the required Data Access tools based on the schema they infer. This will happen when user points the app to a new database with the required connection parameters. 
- The Agantic AI should be MCP ccompliant and should be able to connect and access the services of the configured MCP servers. There should be facility to configure the MCP servers. 
- Cancellation & Steering: Support mid-generation abort (AbortController), allowing users to pause, edit an agent's planned tool action, or stop runaway agent loops.
- Context Management & Token Economy
    Exact Token Counting & Cost Tracking: Integrate exact tokenizers (e.g. tiktoken for OpenAI, provider-specific counts) to calculate per-session token usage and real-time cost estimation.

    Hierarchical Context Compaction: Implement strategies such as:
        Rolling summarization of earlier dialogue turns.
    Tool output trimming (truncating large terminal/search outputs after the agent extracts the essential answer).
    Sliding window retention for system prompts + recent turns.
- The multi-agenti system should implement various types of agents that perform different tasks such as : Planning, Orchectration, Terminal/DevOps operations, Research, Coding and execution, Data rendering, data IO operations, distribution, etc.
