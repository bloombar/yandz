/**
 * Automatic version names. Generates a friendly, random two-word name (e.g.
 * "Brave Otter") using the well-maintained `unique-names-generator` package, so
 * every version has a readable name without the user having to pick one. The user
 * can still override it by typing a name; that name is persisted instead.
 */
import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';

/** A capitalized two-word name like "Calm Falcon". */
export function generateVersionName(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: ' ',
    style: 'capital',
    length: 2,
  });
}
