/**
 * Tokenizes and cleans a string
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 0);
}

/**
 * Pure TF-IDF Service for calculating document similarities
 */
export class TfIdfService {
  /**
   * Calculates term frequencies for a given list of tokens
   */
  private getTermFrequencies(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    if (tokens.length === 0) return tf;

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Normalize TF
    for (const [token, count] of tf.entries()) {
      tf.set(token, count / tokens.length);
    }

    return tf;
  }

  /**
   * Calculates Inverse Document Frequency for all unique terms across documents
   */
  private getInverseDocumentFrequencies(
    docsTokens: string[][],
    vocabulary: Set<string>
  ): Map<string, number> {
    const idf = new Map<string, number>();
    const N = docsTokens.length;

    for (const term of vocabulary) {
      let docsWithTerm = 0;
      for (const tokens of docsTokens) {
        if (tokens.includes(term)) {
          docsWithTerm++;
        }
      }
      // IDF formula with smoothing to avoid division by zero
      idf.set(term, Math.log((1 + N) / (1 + docsWithTerm)));
    }

    return idf;
  }

  /**
   * Calculates cosine similarity between two vectors
   */
  private cosineSimilarity(
    vec1: Map<string, number>,
    vec2: Map<string, number>,
    vocabulary: Set<string>
  ): number {
    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (const term of vocabulary) {
      const val1 = vec1.get(term) || 0;
      const val2 = vec2.get(term) || 0;

      dotProduct += val1 * val2;
      magnitude1 += val1 * val1;
      magnitude2 += val2 * val2;
    }

    if (magnitude1 === 0 || magnitude2 === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(magnitude1) * Math.sqrt(magnitude2));
  }

  /**
   * Matches a prompt against all titles using TF-IDF cosine similarity
   * @param prompt The incoming user prompt/message
   * @param titles List of eagerly loaded titles
   * @param topK Number of top matching titles to return
   * @returns Array of matched titles sorted by score descending
   */
  public matchTitles(
    prompt: string,
    titles: string[],
    topK: number = 2
  ): Array<{ title: string; score: number }> {
    if (titles.length === 0) return [];

    const queryTokens = tokenize(prompt);
    if (queryTokens.length === 0) {
      return titles.map(title => ({ title, score: 0 }));
    }

    const docsTokens = titles.map(title => tokenize(title));
    const vocabulary = new Set<string>();

    // Build vocabulary
    for (const tokens of docsTokens) {
      for (const token of tokens) {
        vocabulary.add(token);
      }
    }
    for (const token of queryTokens) {
      vocabulary.add(token);
    }

    // Compute IDF
    const idf = this.getInverseDocumentFrequencies(docsTokens, vocabulary);

    // Compute TF-IDF vectors for documents
    const docVectors = docsTokens.map(tokens => {
      const tf = this.getTermFrequencies(tokens);
      const tfidf = new Map<string, number>();
      for (const term of vocabulary) {
        const tfVal = tf.get(term) || 0;
        const idfVal = idf.get(term) || 0;
        tfidf.set(term, tfVal * idfVal);
      }
      return tfidf;
    });

    // Compute TF-IDF vector for query
    const queryTf = this.getTermFrequencies(queryTokens);
    const queryVector = new Map<string, number>();
    for (const term of vocabulary) {
      const tfVal = queryTf.get(term) || 0;
      const idfVal = idf.get(term) || 0;
      queryVector.set(term, tfVal * idfVal);
    }

    // Compute similarities
    const results = titles.map((title, index) => {
      const score = this.cosineSimilarity(queryVector, docVectors[index], vocabulary);
      return { title, score };
    });

    // Sort descending by score and filter out zero scores
    return results
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

export const tfIdfService = new TfIdfService();
