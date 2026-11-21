const state = {
  jobs: [],
  page: 1,
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
  pagination: document.querySelector("#pagination"),
  paginationInfo: document.querySelector("#pagination-info"),
  resultsCaption: document.querySelector("#results-caption"),
  resultsCount: document.querySelector("#results-count"),
  roleFilter: document.querySelector("#role-filter"),
  searchForm: document.querySelector("#search-form"),
  searchInput: document.querySelector("#search-input"),
  sourceList: document.querySelector("#source-list"),
  sourceMarqueeTrack: document.querySelector("#source-marquee-track"),
  statFullTime: document.querySelector("#stat-full-time"),
  statOpenings: document.querySelector("#stat-openings"),
  statSources: document.querySelector("#stat-sources"),
  sortFilter: document.querySelector("#sort-filter"),
  typeFilter: document.querySelector("#type-filter"),
  updatedAt: document.querySelector("#updated-at"),
};

const numberFormat = new Intl.NumberFormat("en-IN");
const jobsPerPage = 50;

function getSourceNames(data) {
  const listedSources = Array.isArray(data.sources) ? data.sources : [];
  const namedSources = listedSources
    .map((source) => (typeof source === "string" ? source : source?.name))
    .filter((name) => typeof name === "string" && name.trim());
  if (namedSources.length) return [...new Set(namedSources)].sort((a, b) => a.localeCompare(b));

  const jobSources = data.jobs.flatMap((job) =>
    Array.isArray(job.sources)
      ? job.sources.map((source) => (typeof source === "string" ? source : source?.name))
      : [],
  );
  const sources = jobSources.filter((name) => typeof name === "string" && name.trim());
  return [...new Set(sources.length ? sources : data.jobs.map((job) => job.company).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function renderSourceMarquee(sourceNames) {
  const group = document.createElement("div");
  group.className = "source-marquee-group";

  sourceNames.forEach((name) => {
    const item = document.createElement("span");
    item.className = "source-marquee-item";
    const mark = document.createElement("span");
    mark.className = "source-mark";
    mark.textContent = name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
    const label = document.createElement("span");
    label.textContent = name;
    item.append(mark, label);
    group.append(item);
  });

  const duplicate = group.cloneNode(true);
  duplicate.setAttribute("aria-hidden", "true");
  elements.sourceMarqueeTrack.replaceChildren(group, duplicate);
  elements.sourceList.replaceChildren(
    ...sourceNames.map((name) => {
      const item = document.createElement("li");
      item.textContent = name;
      return item;
    }),
  );
}

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

function canonicalCity(city, location) {
  const candidates = [city, location].filter(
    (value) => value && !["not specified", "unknown", "location not listed"].includes(value.trim().toLowerCase()),
  );
  const aliases = [
    ["Bengaluru", ["bengaluru", "bangalore", "banglore"]],
    ["Mumbai", ["mumbai"]],
    ["Delhi", ["delhi"]],
    ["Gurugram", ["gurugram", "gurgaon"]],
    ["Hyderabad", ["hyderabad"]],
    ["Pune", ["pune"]],
    ["Chennai", ["chennai"]],
    ["Kolkata", ["kolkata"]],
    ["Noida", ["noida"]],
    ["Ahmedabad", ["ahmedabad"]],
    ["Kochi", ["kochi"]],
    ["Jaipur", ["jaipur"]],
    ["Indore", ["indore"]],
  ];
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    for (const [canonical, names] of aliases) {
      if (names.some((name) => new RegExp(`\\b${name}\\b`, "i").test(normalized))) {
        return canonical;
      }
    }
  }
  for (const candidate of candidates) {
    if (/^(remote|distributed|anywhere|worldwide|global)(\s|$|[·,])/i.test(candidate.trim())) {
      return "Remote";
    }
  }
  return candidates[0]?.trim() || "Not specified";
}

function inferRoleFromTitle(title) {
  const normalized = title.toLowerCase();
  const roles = [
    ["Content & Copywriting", /\b(copywriter|copy writer|content writer|technical writer|editor)\b/],
    ["Research", /\b(research|researcher)\b/],
    ["Data", /\b(data|analytics|analyst|machine learning)\b/],
    ["Design", /\b(design|designer|ux|ui)\b/],
    ["Engineering", /\b(engineer|engineering|developer|devops|sre|software)\b/],
    ["Product", /\b(product manager|product owner|product)\b/],
    ["Marketing", /\b(marketing|communications|seo|public relations)\b/],
    ["Sales", /\b(sales|account executive|account manager)\b/],
    ["Business Development", /\b(business development|partnerships)\b/],
    ["Finance", /\b(finance|accountant|accounting|audit|treasury)\b/],
    ["Human Resources", /\b(hr|hrbp|human resources|recruiter|recruiting|talent)\b/],
    ["Operations", /\b(operations|supply chain|logistics)\b/],
    ["Customer Success", /\bcustomer success\b/],
    ["Customer Support", /\b(support|service desk)\b/],
    ["Legal", /\b(legal|counsel|attorney)\b/],
  ];
  return roles.find(([, pattern]) => pattern.test(normalized))?.[0];
}

function normalizeJobForDisplay(job) {
  const title = job.title || "";
  const titleSuggestsInternship = /\b(intern|internship)\b/i.test(title);
  const sourceType = (job.sourceEmploymentType || "").trim().toLowerCase().replace(/[_-]+/g, " ");
  const sourceTypeAliases = {
    "full time": "Full-time",
    fulltime: "Full-time",
    permanent: "Full-time",
    intern: "Internship",
    internship: "Internship",
    contract: "Contract",
    contractor: "Contract",
    "part time": "Part-time",
    parttime: "Part-time",
    other: "Other",
  };
  const roleAliases = {
    hr: "Human Resources",
    "human resources": "Human Resources",
    content: "Content & Copywriting",
    copywriting: "Content & Copywriting",
    "customer service": "Customer Support",
  };
  const role = inferRoleFromTitle(title)
    || roleAliases[job.role?.trim().toLowerCase()]
    || job.role
    || "Other";
  const city = canonicalCity(job.city, job.location);
  const employmentType = sourceTypeAliases[sourceType]
    || (job.employmentType === "Internship"
      ? (titleSuggestsInternship ? "Internship" : "Other")
      : (job.employmentType === "Other" && titleSuggestsInternship
        ? "Internship"
        : job.employmentType));
  return {
    ...job,
    city,
    role,
    employmentType: employmentType || "Other",
  };
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

  const source = job.sources?.[0];
  const sourceLink = document.createElement("a");
  sourceLink.className = "source-link";
  sourceLink.href = source?.url || job.url;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";
  if (source?.name && source?.url) {
    sourceLink.textContent = `Via ${source.name}`;
    sourceLink.setAttribute("aria-label", `Visit ${source.name} source for ${job.title}`);
  } else {
    sourceLink.textContent = "Original source";
    sourceLink.setAttribute("aria-label", `View ${job.title} at ${job.company} on the original source`);
  }
  const sourceArrow = document.createElement("span");
  sourceArrow.className = "source-arrow";
  sourceArrow.setAttribute("aria-hidden", "true");
  sourceArrow.textContent = "↗";
  sourceLink.append(sourceArrow);
  top.append(mark, companyBlock, sourceLink);

  const title = document.createElement("h4");
  title.className = "job-title";
  title.textContent = job.title;

  const location = document.createElement("p");
  location.className = "job-location";
  location.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 6.7c0 3.5-5 7.4-5 7.4S3 10.2 3 6.7a5 5 0 1 1 10 0Z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="6.5" r="1.5" stroke="currentColor" stroke-width="1.3"/></svg>';
  const locationText = document.createElement("span");
  locationText.textContent = formatJobLocation(job);
  location.append(locationText);

  const details = document.createElement("div");
  details.className = "job-details";
  const tags = document.createElement("div");
  tags.className = "job-tags";
  tags.append(makeTag(job.employmentType || "Full-time", "tag-type"));
  tags.append(makeTag(job.level || "Unspecified"));
  tags.append(makeTag(job.role || "Other"));
  if (job.tagSource === "rule-based") tags.append(makeTag("Rule-based tags"));
  details.append(location, tags);

  const footer = document.createElement("div");
  footer.className = "job-card-footer";
  if (job.salary) {
    const salary = document.createElement("span");
    salary.className = "salary-label";
    salary.textContent = job.salary;
    footer.append(salary);
  }

  card.append(top, title, details);
  if (job.salary) card.append(footer);
  return card;
}

function addPageButton(page, currentPage) {
  const button = document.createElement("button");
  button.className = "page-button";
  button.type = "button";
  button.textContent = numberFormat.format(page);
  button.setAttribute("aria-label", `Page ${page}`);
  if (page === currentPage) {
    button.classList.add("current");
    button.setAttribute("aria-current", "page");
  }
  button.addEventListener("click", () => {
    state.page = page;
    render();
    document.querySelector("#results-heading").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  elements.pagination.append(button);
}

function addPageEllipsis() {
  const ellipsis = document.createElement("span");
  ellipsis.className = "page-ellipsis";
  ellipsis.setAttribute("aria-hidden", "true");
  ellipsis.textContent = "…";
  elements.pagination.append(ellipsis);
}

function renderPagination(totalJobs, pageCount, startIndex) {
  elements.pagination.replaceChildren();
  elements.pagination.hidden = pageCount <= 1;
  elements.paginationInfo.textContent = totalJobs
    ? `Showing ${numberFormat.format(startIndex + 1)}–${numberFormat.format(
        Math.min(startIndex + jobsPerPage, totalJobs),
      )} of ${numberFormat.format(totalJobs)}`
    : "";
  if (pageCount <= 1) return;

  const previous = document.createElement("button");
  previous.className = "page-button page-step";
  previous.type = "button";
  previous.textContent = "Previous";
  previous.disabled = state.page === 1;
  previous.addEventListener("click", () => {
    state.page -= 1;
    render();
    document.querySelector("#results-heading").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  elements.pagination.append(previous);

  if (pageCount <= 7) {
    for (let page = 1; page <= pageCount; page += 1) addPageButton(page, state.page);
  } else {
    addPageButton(1, state.page);
    if (state.page > 3) addPageEllipsis();

    const firstNearbyPage = Math.max(2, state.page - 1);
    const lastNearbyPage = Math.min(pageCount - 1, state.page + 1);
    for (let page = firstNearbyPage; page <= lastNearbyPage; page += 1) {
      addPageButton(page, state.page);
    }

    if (state.page < pageCount - 2) addPageEllipsis();
    addPageButton(pageCount, state.page);
  }

  const next = document.createElement("button");
  next.className = "page-button page-step";
  next.type = "button";
  next.textContent = "Next";
  next.disabled = state.page === pageCount;
  next.addEventListener("click", () => {
    state.page += 1;
    render();
    document.querySelector("#results-heading").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  elements.pagination.append(next);
}

function render() {
  const visibleJobs = sortJobs(state.jobs.filter(matches));
  const pageCount = Math.ceil(visibleJobs.length / jobsPerPage);
  state.page = Math.min(state.page, Math.max(pageCount, 1));
  const startIndex = (state.page - 1) * jobsPerPage;
  const pageJobs = visibleJobs.slice(startIndex, startIndex + jobsPerPage);
  elements.grid.replaceChildren();
  elements.resultsCount.textContent = numberFormat.format(visibleJobs.length);
  renderPagination(visibleJobs.length, pageCount, startIndex);
  elements.clearFilters.hidden = !(
    state.query || state.location || state.role || state.type || state.level
  );

  if (visibleJobs.length) {
    elements.emptyState.hidden = true;
    elements.grid.hidden = false;
    elements.resultsCaption.textContent = state.query
      ? `Showing matches for “${state.query.trim()}”.`
      : "A little momentum goes a long way.";
    pageJobs.forEach((job, index) => elements.grid.append(renderJob(job, index)));
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
  state.page = 1;
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

    state.jobs = data.jobs.map(normalizeJobForDisplay);
    const sourceNames = getSourceNames(data);
    hasLoadedJobs = true;
    renderSourceMarquee(sourceNames);
    elements.statOpenings.textContent = numberFormat.format(state.jobs.length);
    elements.statSources.textContent = numberFormat.format(
      data.sourceCount ?? sourceNames.length,
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
  state.page = 1;
  state.query = elements.searchInput.value;
  render();
  document.querySelector("#openings-title").scrollIntoView({ behavior: "smooth", block: "start" });
});
elements.searchInput.addEventListener("input", () => {
  state.page = 1;
  state.query = elements.searchInput.value;
  render();
});
elements.locationFilter.addEventListener("change", () => {
  state.page = 1;
  state.location = elements.locationFilter.value;
  render();
});
elements.roleFilter.addEventListener("change", () => {
  state.page = 1;
  state.role = elements.roleFilter.value;
  render();
});
elements.typeFilter.addEventListener("change", () => {
  state.page = 1;
  state.type = elements.typeFilter.value;
  render();
});
elements.levelFilter.addEventListener("change", () => {
  state.page = 1;
  state.level = elements.levelFilter.value;
  render();
});
elements.sortFilter.addEventListener("change", () => {
  state.page = 1;
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
