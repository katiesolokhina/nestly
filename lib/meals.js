// The meal's name: the recipe's current name, or what was typed (also kept if the recipe is deleted).
function titled(meals, recipes) {
  const byId = new Map(recipes.map((r) => [String(r._id), r]));
  return meals.map((m) => {
    const r = m.recipeId && byId.get(String(m.recipeId));
    return { ...m, name: r ? r.title : m.title || 'Meal', hasRecipe: Boolean(r) };
  });
}

module.exports = { titled };
