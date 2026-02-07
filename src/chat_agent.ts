import { Knowledge } from './knowledge';

interface MistralConversationResponseOutput {
  content: string;
  type: string;
}

interface MistralConversationResponse {
  outputs: MistralConversationResponseOutput[];
}

interface MistralConversationMeta {
  name: string;
  id: string;
  updated_at: string;
  agent_id: string;
}

export class ChatAgent {
  private url: string;
  private apiKey: string;
  private agentId: string;
  private knowledge = new Knowledge();

  constructor(url: string, apiKey: string, agentId: string) {
    this.url = url;
    this.apiKey = apiKey;
    this.agentId = agentId;
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private buildInitialPrompt(userText: string, username: string, shortAnswer: boolean): string {
    const capitalizedUsername = this.capitalize(username);
    return `
      You are talking to ${capitalizedUsername}, who is ${this.knowledge.getAgeOf(username)} years old.
      You are the ${this.knowledge.getFamilyRelationTo(username)} of ${capitalizedUsername}.
      ${shortAnswer ? 'Your answer should have less than 1900 characters' : ''}.

      Request from ${capitalizedUsername}:
      ${userText}
    `;
  }

  private async getActiveConversationId(username: string): Promise<string | undefined> {
    const response = await fetch(this.url, {
      method: 'get',
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    }).then(x => x.json());
    //console.log(`INFO Received raw conversations from mistral: ${JSON.stringify(response)}`);
    return (<MistralConversationMeta[]>response)
      .filter(
        c =>
          c.name == username &&
          c.agent_id == this.agentId &&
          Date.parse(c.updated_at) > Date.now() - 24 * 60 * 60 * 1000
      )
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
      .pop()?.id;
  }

  async processRequest(userText: string, username: string, shortAnswer: boolean = false): Promise<string> {
    const conversationId = await this.getActiveConversationId(username);
    console.log(`INFO Existing conversation ${conversationId}`);
    const body = {
      agent_id: conversationId ? undefined : this.agentId,
      name: conversationId ? undefined : username,
      inputs: [
        {
          role: 'user',
          content: conversationId
            ? userText
            : this.buildInitialPrompt(userText, username, shortAnswer)
        }
      ]
    };
    console.log(`INFO Sending prompt to LLM agent: ${JSON.stringify(body)}`);
    const response = await fetch(conversationId ? `${this.url}/${conversationId}` : this.url, {
      method: 'post',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      }
    }).then(x => x.json());
    console.log(`INFO Received raw answer from mistral: ${JSON.stringify(response)}`);
    const outputs = (<MistralConversationResponse>response).outputs;
    return outputs[outputs.length - 1].content;
  }
}
