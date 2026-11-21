const state = {
  jobs: [],
  query: "",
  location: "",
  role: "",
  type: "",
  level: "",
  sort: "newest",
};
let hasLoadedJobs = false;

const elements = {
  clearFilters: document.querySelector("#clear-filters"),
  countLabel: document.querySelector("#count-label"),
  emptyAction: document.querySelector("#empty-action"),
  emptyMessage: document.querySelector("#empty-message"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  grid: document.querySelector("#job-grid"),
  levelFilter: document.querySelector("#level-filter"),
  locationFilter: document.querySelector("#location-filter"),
  resultsCaption: document.querySelector("#results-caption"),
  resultsCount: document.querySelector("#results-count"),
  roleFilter: document.querySelector("#role-filter"),
  searchForm: document.querySelector("#search-form"),
  searchInput: document.querySelector("#search-input"),
  statFullTime: document.querySelector("#stat-full-time"),
  statOpenings: document.querySelector("#stat-openings"),
  statSources: document.querySelector("#stat-sources"),
  sortFilter: document.querySelector("#sort-filter"),
  typeFilter: document.querySelector("#type-filter"),
  updatedAt: document.querySelector("#updated-at"),
};

const numberFormat = new Intl.NumberFormat("en-IN");

function safeDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date : null;
}

function relativeDate(value) {
  const date = safeDate(value);
  if (!date) return "Recently posted";
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(date);
}

function formatUpdated(value) {
  const date = safeDate(value);
  if (!date) return "Awaiting first refresh";
  const dateLabel = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
  }).format(date);
  const timeLabel = new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return `${dateLabel}, ${timeLabel}`;
}

function setOptions(select, values, placeholder) {
  const selected = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  [...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .forEach((value) => select.add(new Option(value, value)));
  select.value = values.includes(selected) ? selected : "";
}

function updateFilterOptions() {
  setOptions(
    elements.locationFilter,
    state.jobs.map((job) => job.city),
    "All locations",
  );
  setOptions(elements.roleFilter, state.jobs.map((job) => job.role), "All roles");
}

function matches(job) {
  const query = state.query.trim().toLocaleLowerCase();
  const searchable = [
    job.title,
    job.company,
    job.city,
    job.role,
    job.level,
    job.employmentType,
    job.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return (
    (!query || searchable.includes(query)) &&
    (!state.location || job.city === state.location) &&
    (!state.role || job.role === state.role) &&
    (!state.type || job.employmentType === state.type) &&
    (!state.level || job.level === state.level)
  );
}

function sortJobs(jobs) {
  return [...jobs].sort((a, b) => {
    if (state.sort === "company") return a.company.localeCompare(b.company);
    if (state.sort === "role") return a.title.localeCompare(b.title);
    return (safeDate(b.postedAt)?.valueOf() ?? 0) - (safeDate(a.postedAt)?.valueOf() ?? 0);
  });
}

function formatJobLocation(job) {
  const city = job.city?.trim();
  const location = job.location?.trim();
  if (!city || city.toLocaleLowerCase() === "not specified") {
    return location || city || "Location not listed";
  }
  if (!location) return city;
  const escapedCity = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const detail = location
    .replace(new RegExp(`^${escapedCity}(?:\\s*[,·–-]\\s*)?`, "i"), "")
    .trim();
  return detail ? `${city} · ${detail}` : city;
}

function makeTag(text, className = "") {
  const tag = document.createElement("span");
  tag.className = `job-tag ${className}`.trim();
  tag.textContent = text;
  return tag;
}

function renderJob(job, index) {
  const card = document.createElement("article");
  card.className = "job-card";
  card.style.setProperty("--card-order", index);

  const top = document.createElement("div");
  top.className = "job-card-top";

  const mark = document.createElement("div");
  mark.className = `company-mark mark-${index % 5}`;
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = job.company
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();

  const companyBlock = document.createElement("div");
  companyBlock.className = "company-block";
  const company = document.createElement("p");
  company.className = "company-name";
  company.textContent = job.company;
  const posted = document.createElement("p");
  posted.className = "posted-at";
  posted.textContent = relativeDate(job.postedAt);
  companyBlock.append(company, posted);

  const applyLink = document.createElement("a");
  applyLink.className = "card-arrow";
  applyLink.href = job.url;
  applyLink.target = "_blank";
  applyLink.rel = "noopener noreferrer";
  applyLink.setAttribute("aria-label", `View ${job.title} at ${job.company} on the original source`);
  applyLink.innerHTML = '<span aria-hidden="true">↗</span>';
  top.append(mark, companyBlock, applyLink);

  const title = document.createElement("h4");
  title.className = "job-title";
  title.textContent = job.title;

  const location = document.createElement("p");
  location.className = "job-location";
  location.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 6.7c0 3.5-5 7.4-5 7.4S3 10.2 3 6.7a5 5 0 1 1 10 0Z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="6.5" r="1.5" stroke="currentColor" stroke-width="1.3"/></svg>';
  const locationText = document.createElement("span");
  locationText.textContent = formatJobLocation(job);
  location.append(locationText);

  const tags = document.createElement("div");
  tags.className = "job-tags";
  tags.append(makeTag(job.employmentType || "Full-time", "tag-type"));
  tags.append(makeTag(job.level || "Unspecified"));
  tags.append(makeTag(job.role || "Other"));
  if (job.tagSource === "rule-based") tags.append(makeTag("Rule-based tags"));

  const footer = document.createElement("div");
  footer.className = "job-card-footer";
  const source = job.sources?.[0];
  if (source?.name && source?.url) {
    const sourceLink = document.createElement("a");
    sourceLink.className = "source-link";
    sourceLink.href = source.url;
    sourceLink.target = "_blank";
    sourceLink.rel = "noopener noreferrer";
    sourceLink.textContent = `Via ${source.name}`;
    footer.append(sourceLink);
  } else {
    const sourceText = document.createElement("span");
    sourceText.className = "source-link";
    sourceText.textContent = "Original source";
    footer.append(sourceText);
  }
  if (job.salary) {
    const salary = document.createElement("span");
    salary.className = "salary-label";
    salary.textContent = job.salary;
    footer.append(salary);
  }

  card.append(top, title, location, tags, footer);
  return card;
}

function render() {
  const visibleJobs = sortJobs(state.jobs.filter(matches));
  elements.grid.replaceChildren();
  elements.resultsCount.textContent = numberFormat.format(visibleJobs.length);
  elements.clearFilters.hidden = !(
    state.query || state.location || state.role || state.type || state.level
  );

  if (visibleJobs.length) {
    elements.emptyState.hidden = true;
    elements.grid.hidden = false;
    elements.resultsCaption.textContent = state.query
      ? `Showing matches for “${state.query.trim()}”.`
      : "A little momentum goes a long way.";
    visibleJobs.forEach((job, index) => elements.grid.append(renderJob(job, index)));
    return;
  }

  elements.grid.hidden = true;
  elements.emptyState.hidden = false;
  const hasFilters = Boolean(state.query || state.location || state.role || state.type || state.level);
  elements.emptyTitle.textContent = hasFilters ? "No matches just yet" : "Your board is ready to grow";
  elements.emptyMessage.textContent = hasFilters
    ? "Try a different search or clear a filter to see more opportunities."
    : "Connect a permitted job feed and an LLM API key to publish live, verified listings. We never invent job posts.";
  elements.emptyAction.hidden = !hasFilters;
  elements.resultsCaption.textContent = hasFilters
    ? "Try another search to keep the possibilities open."
    : "Fresh, source-linked listings will appear here.";
}

function clearFilters() {
  state.query = "";
  state.location = "";
  state.role = "";
  state.type = "";
  state.level = "";
  elements.searchInput.value = "";
  elements.locationFilter.value = "";
  elements.roleFilter.value = "";
  elements.typeFilter.value = "";
  elements.levelFilter.value = "";
  render();
}

async function loadJobs() {
  const firstLoad = !hasLoadedJobs;
  if (firstLoad) {
    elements.grid.innerHTML = '<div class="loading-state"><span class="loader" aria-hidden="true"></span> Gathering today’s opportunities…</div>';
    elements.grid.hidden = false;
    elements.emptyState.hidden = true;
  }
  try {
    const response = await fetch("/data/jobs.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`The job feed returned ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data.jobs)) throw new Error("The job feed has an invalid format.");

    state.jobs = data.jobs;
    hasLoadedJobs = true;
    elements.statOpenings.textContent = numberFormat.format(state.jobs.length);
    elements.statSources.textContent = numberFormat.format(
      data.sourceCount ?? data.sources?.length ?? 0,
    );
    elements.statFullTime.textContent = numberFormat.format(
      state.jobs.filter((job) => job.employmentType === "Full-time").length,
    );
    elements.updatedAt.textContent = formatUpdated(data.updatedAt);
    updateFilterOptions();
    render();
  } catch (error) {
    elements.updatedAt.textContent = "Unavailable";
    if (!firstLoad) {
      elements.resultsCaption.textContent = "Could not refresh; showing the last loaded listings.";
      return;
    }
    elements.grid.hidden = true;
    elements.emptyState.hidden = false;
    elements.emptyTitle.textContent = "We couldn’t load the board";
    elements.emptyMessage.textContent = `${error.message} Please try again in a moment.`;
    elements.emptyAction.hidden = false;
    elements.emptyAction.textContent = "Try again →";
    elements.resultsCaption.textContent = "The listings are temporarily unavailable.";
  }
}

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.query = elements.searchInput.value;
  render();
  document.querySelector("#openings-title").scrollIntoView({ behavior: "smooth", block: "start" });
});
elements.searchInput.addEventListener("input", () => {
  state.query = elements.searchInput.value;
  render();
});
elements.locationFilter.addEventListener("change", () => {
  state.location = elements.locationFilter.value;
  render();
});
elements.roleFilter.addEventListener("change", () => {
  state.role = elements.roleFilter.value;
  render();
});
elements.typeFilter.addEventListener("change", () => {
  state.type = elements.typeFilter.value;
  render();
});
elements.levelFilter.addEventListener("change", () => {
  state.level = elements.levelFilter.value;
  render();
});
elements.sortFilter.addEventListener("change", () => {
  state.sort = elements.sortFilter.value;
  render();
});
elements.clearFilters.addEventListener("click", clearFilters);
elements.emptyAction.addEventListener("click", () => {
  if (state.jobs.length) clearFilters();
  else loadJobs();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.searchInput.focus();
  }
});

loadJobs();
window.setInterval(() => {
  if (!document.hidden) loadJobs();
}, 60 * 60 * 1000);
