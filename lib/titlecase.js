// Names and titles in Title Case: each word that was typed all lowercase gets a capital first
// letter. Words with a capital already (iPhone, BBQ, McDonald's) and ones starting with a number
// (2% milk, 14oz) stay as typed.
function titleCase(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/(^|[\s(/"“])(\p{Ll})(\p{L}*)/gu, (m, before, first, rest) => {
    const word = first + rest;
    return word === word.toLowerCase() ? before + first.toUpperCase() + rest : m;
  });
}

module.exports = { titleCase };
