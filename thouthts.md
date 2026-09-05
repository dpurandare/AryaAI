I want to create a portable desktop application and the main points are as follows:

1. The application will run on Linux, Mac and Windows. We may consider using the Electron application development framework. We will use JavaScript/TypeScript as our preference for the development language. The application used the Agentic AI. We should not use any third party Agentic AI Framework (such as LangChain) and develop our own Agentic AI layer (similar to what Anthropic developed and available as https://www.npmjs.com/package/@anthropic-ai/sdk)

2. The application will have installers for individual OS. 

3. The application will maintain the version numbers. The version number policy would be major, minor, point release type that is followed in the industry. 

4. The application will not have any backend server needs and should run independently.

5. The application should facilitate the access to the public as well as local LLMs. We should support OpenAI, Anthropic, Google, Ollama in the beginning. It should be possible to add the support for any new model provider easily.

6. User should be given facility to choose the LLM model during runtime. 

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

