import { describe, expect, it } from 'vitest'
import { classifyGreeting, enforceGreetingReply, stripGenericClosing } from './greeting-reply'

describe('classifyGreeting (#242)', () => {
  it('recognises a bare greeting and a "what can you do" question, and nothing else', () => {
    for (const t of ['Hello', 'hello!', 'Hi there', 'hey', 'Good morning', 'namaste', 'Hello everyone', 'hey, team!']) expect(classifyGreeting(t), t).toBe('greeting')
    expect(classifyGreeting('Hello Planner', 'Planner')).toBe('greeting')
    expect(classifyGreeting('Hello Planner')).toBeUndefined() // another name is not a greeting word
    for (const t of ['What can you do?', 'what can you do', 'Which tools do you have?', 'who are you?', 'What do you do?']) expect(classifyGreeting(t), t).toBe('capabilities')
    for (const t of ['Hello, please summarise report.pdf', 'Compare Python and Rust in two sentences.', 'hi can you read a.txt', '', 'What can you do with my Q3 sales file and how long would it take?', 'hey explain recursion', 'hi summarise report', 'yo run tests', 'what are you doing?', 'what are you looking at']) {
      expect(classifyGreeting(t), t).toBeUndefined()
    }
    expect(classifyGreeting('Hello\nplease do X')).toBeUndefined()
  })
})

describe('stripGenericClosing (#242)', () => {
  it('removes the generic closing offers the notice forbids and keeps the rest exactly', () => {
    expect(stripGenericClosing("I'm Developer. I write and run code. How can I assist you today?")).toBe("I'm Developer. I write and run code.")
    expect(stripGenericClosing("I'm Email. I send mail.\n\nFeel free to ask me anything!")).toBe("I'm Email. I send mail.")
    expect(stripGenericClosing("I'm Planner. I plan. Let me know how I can help. How can I assist you today?")).toBe("I'm Planner. I plan.")
    expect(stripGenericClosing('I am here to help. What would you like to do?')).toBe('I am here to help.')
  })

  it('leaves a reply without a generic closing alone, and never strips the whole reply', () => {
    const fine = "I'm Researcher: I search the web with web_search and parse_html."
    expect(stripGenericClosing(fine)).toBe(fine)
    expect(stripGenericClosing('How can I assist you today?')).toBe('How can I assist you today?')
  })
})

describe('enforceGreetingReply (#242)', () => {
  const tools = ['read_file', 'list_directory', 'find_files', 'find_in_files', 'write_file', 'shell_execute', 'python_run', 'git_exec', 'git_clone_repo', 'aws_cli']

  it('appends the tool names (about eight for a greeting) when the reply names none, and drops the generic closing', () => {
    const out = enforceGreetingReply("I'm Developer, and I write and run code. How can I assist you today?", 'greeting', tools)
    expect(out).toBe("I'm Developer, and I write and run code.\n\nMy tools: read_file, list_directory, find_files, find_in_files, write_file, shell_execute, python_run, git_exec, and more.")
  })

  it('lists every tool for a capabilities question', () => {
    const out = enforceGreetingReply('I can work with code and files.', 'capabilities', tools)
    expect(out.endsWith('git_clone_repo, aws_cli.')).toBe(true)
  })

  it('adds nothing when the reply already names one of the tools, or when the role has no tools', () => {
    const named = "I'm Developer. My tools include shell_execute and python_run."
    expect(enforceGreetingReply(named, 'greeting', tools)).toBe(named)
    expect(enforceGreetingReply("I'm Planner. I plan. How can I assist you today?", 'greeting', [])).toBe("I'm Planner. I plan.")
  })

  it('is idempotent', () => {
    const once = enforceGreetingReply("I'm Email. I send mail. How can I help?", 'greeting', ['send_email'])
    expect(enforceGreetingReply(once, 'greeting', ['send_email'])).toBe(once)
  })

  it('says the specialist\'s Agent-menu name first when the reply never uses it', () => {
    const out = enforceGreetingReply('I can write and run code. My tools include shell_execute.', 'capabilities', ['shell_execute'], 'Developer')
    expect(out).toBe("I'm Developer. I can write and run code. My tools include shell_execute.")
    const named = "I'm Developer. I write code with shell_execute."
    expect(enforceGreetingReply(named, 'greeting', ['shell_execute'], 'Developer')).toBe(named)
  })
})
