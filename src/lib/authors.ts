import authorsData from '../data/authors.json';

export interface Author {
  id: number;
  name: string;
  role: string;
  avatar: string;
  bio: string;
}

export const authors: Author[] = authorsData;

export function getAuthorById(id: number): Author | undefined {
  return authors.find((a) => a.id === id);
}

export function getAuthorByName(name: string): Author | undefined {
  return authors.find((a) => a.name === name);
}
